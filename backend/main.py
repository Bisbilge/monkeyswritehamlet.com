"""
Sonsuz Maymun Teoremi — Backend (FastAPI)
==========================================

Oyun mantığı KASITLI olarak tamamen sunucu tarafındadır:

    - Rastgele karakter sunucuda, kriptografik olarak güvenli bir
      üreteçle (secrets.choice) seçilir. İstemci hangi karakterin
      üretileceğini ASLA etkileyemez.
    - "Doğru mu?" karşılaştırması, ilerleme (current_index) ve seri
      (streak) sunucudaki veritabanında, imzalı bir session cookie'sine
      bağlı olarak tutulur. İstemci sadece "zar at" der, sonucu okur.
    - Leaderboard'a yazılan skor, istemcinin gönderdiği bir sayı
      DEĞİL, o session için veritabanında biriken best_streak
      değeridir. Yani istemci "1500 attım" diyerek skor giremez.

Bu üç kural, aşağıdaki "İstemci tarafı sahtekarlık" senaryolarının
hepsini kapatır: sahte "doğru" cevabı raporlama, ilerlemeyi
JavaScript'ten manipüle etme, rastgele sayı üretecini tahmin etme.

Geriye kalan tek gerçek tehdit, bir botun insan hızının çok
üzerinde istek atıp "saf hesaplama gücüyle" RNG'yi çok sayıda
deneyerek zorlaması (brute force). Bu da rate limiting + CAPTCHA +
anomali tespitiyle sınırlandırılır (aşağıya ve README'ye bakın).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
import uuid
from collections import deque
from datetime import datetime
from typing import Deque, Dict, Optional

# NOT: Bilerek timezone-naive UTC datetime (datetime.utcnow()) kullanıyoruz.
# SQLite, saklanan datetime'ların tzinfo'sunu round-trip'te kaybeder; bu da
# "offset-naive ile offset-aware çıkarılamaz" hatasına yol açar. Tüm
# zaman damgalarını tutarlı şekilde naive tutmak bunu basitçe önler.
# PostgreSQL'e geçerseniz TIMESTAMPTZ kullanıp aware datetime'a dönebilirsiniz.

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Field as SQLField
from sqlmodel import Session, SQLModel, create_engine, select

# --------------------------------------------------------------------------
# Yapılandırma
# --------------------------------------------------------------------------

SECRET_KEY = os.environ.get("SECRET_KEY", "dev-only-CHANGE-ME-in-production")
DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite:///./monkey.db")
FRONTEND_ORIGINS = os.environ.get("FRONTEND_ORIGINS", "http://localhost:5500,http://127.0.0.1:5500").split(",")

COOKIE_NAME = "monkey_session"
COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30  # 30 gün

# Bir session'ın art arda iki "roll" isteği arasında olması gereken
# minimum süre. İnsan bir düğmeye saniyede 10-12'den fazla tıklayamaz;
# 70ms ~ saniyede ~14 istek üst sınırı koyar (cömert ama script'lerin
# "olabildiğince hızlı" spam atmasını engeller).
MIN_ROLL_INTERVAL_MS = 70

# IP başına kaba bir sliding-window limiti: tek bir IP'nin çok sayıda
# session açıp paralel "farm" yapmasını zorlaştırır. Tek işlemlik bir
# demo için bellek-içi; prod'da Redis + sabit pencere/token bucket
# kullanın (bkz. README "Ölçeklendirme" bölümü).
IP_WINDOW_SECONDS = 10
IP_MAX_REQUESTS_PER_WINDOW = 40

LEADERBOARD_SIZE = 50
NICKNAME_MIN_LEN = 1
NICKNAME_MAX_LEN = 20

ALPHABET = "abcdefghijklmnopqrstuvwxyz "  # 27 karakter (26 harf + boşluk)

# --------------------------------------------------------------------------
# Hedef metin — Hamlet, "To be, or not to be" tiradı
# --------------------------------------------------------------------------

RAW_TARGET_TEXT = """
To be, or not to be, that is the question:
Whether 'tis nobler in the mind to suffer
The slings and arrows of outrageous fortune,
Or to take arms against a sea of troubles
And by opposing end them. To die, to sleep,
No more; and by a sleep to say we end
The heart-ache and the thousand natural shocks
That flesh is heir to: 'tis a consummation
Devoutly to be wish'd. To die, to sleep;
To sleep, perchance to dream: ay, there's the rub,
For in that sleep of death what dreams may come,
When we have shuffled off this mortal coil,
Must give us pause. There's the respect
That makes calamity of so long life.
For who would bear the whips and scorns of time,
The oppressor's wrong, the proud man's contumely,
The pangs of despised love, the law's delay,
The insolence of office, and the spurns
That patient merit of the unworthy takes,
When he himself might his quietus make
With a bare bodkin? Who would fardels bear,
To grunt and sweat under a weary life,
But that the dread of something after death,
The undiscovered country, from whose bourn
No traveller returns, puzzles the will,
And makes us rather bear those ills we have
Than fly to others that we know not of?
Thus conscience does make cowards of us all,
And thus the native hue of resolution
Is sicklied o'er with the pale cast of thought,
And enterprises of great pitch and moment
With this regard their currents turn awry
And lose the name of action.
"""


def normalize_text(text: str) -> str:
    """Sadece a-z ve boşluk bırakır; her şeyi küçük harfe çevirir."""
    text = text.lower()
    text = re.sub(r"[-–—\n\r\t]", " ", text)  # tire/satır -> boşluk
    text = re.sub(r"[^a-z ]", "", text)  # noktalama/apostrof -> silinir
    text = re.sub(r"\s+", " ", text).strip()
    return text


TARGET_TEXT = normalize_text(RAW_TARGET_TEXT)
TARGET_LENGTH = len(TARGET_TEXT)

# --------------------------------------------------------------------------
# Veritabanı modelleri
# --------------------------------------------------------------------------


class GameSession(SQLModel, table=True):
    id: str = SQLField(primary_key=True)
    current_index: int = 0
    current_streak: int = 0
    best_streak: int = 0
    total_rolls: int = 0
    created_at: datetime = SQLField(default_factory=lambda: datetime.utcnow())
    last_roll_at: Optional[datetime] = None
    ip_hash: Optional[str] = None
    flagged: bool = False  # anomali tespitiyle işaretlenirse leaderboard'dan gizlenir


class LeaderboardEntry(SQLModel, table=True):
    session_id: str = SQLField(primary_key=True, foreign_key="gamesession.id")
    nickname: str
    score: int
    achieved_at: datetime = SQLField(default_factory=lambda: datetime.utcnow())


engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False} if "sqlite" in DATABASE_URL else {})


def get_db() -> Session:
    with Session(engine) as session:
        yield session


# --------------------------------------------------------------------------
# Session cookie imzalama (harici bağımlılık olmadan, sadece hmac)
# --------------------------------------------------------------------------


def sign(session_id: str) -> str:
    mac = hmac.new(SECRET_KEY.encode(), session_id.encode(), hashlib.sha256).hexdigest()
    return f"{session_id}.{mac}"


def verify(token: str) -> Optional[str]:
    try:
        session_id, mac = token.rsplit(".", 1)
    except ValueError:
        return None
    expected = hmac.new(SECRET_KEY.encode(), session_id.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(mac, expected):
        return None
    return session_id


def hash_ip(ip: str) -> str:
    return hashlib.sha256((SECRET_KEY + ip).encode()).hexdigest()[:16]


# --------------------------------------------------------------------------
# IP başına bellek-içi rate limiter (bkz. README için Redis notu)
# --------------------------------------------------------------------------

_ip_hits: Dict[str, Deque[float]] = {}


def check_ip_rate_limit(ip: str) -> None:
    now = time.monotonic()
    window = _ip_hits.setdefault(ip, deque())
    while window and now - window[0] > IP_WINDOW_SECONDS:
        window.popleft()
    if len(window) >= IP_MAX_REQUESTS_PER_WINDOW:
        raise HTTPException(status_code=429, detail="Çok fazla istek. Biraz yavaşlayın.")
    window.append(now)


# --------------------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------------------

app = FastAPI(title="Sonsuz Maymun Teoremi API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


def get_or_create_session(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    monkey_session: Optional[str] = Cookie(default=None),
) -> GameSession:
    session_id: Optional[str] = None
    if monkey_session:
        session_id = verify(monkey_session)

    if session_id:
        game_session = db.get(GameSession, session_id)
        if game_session:
            return game_session

    # Yeni session
    session_id = uuid.uuid4().hex
    ip = request.client.host if request.client else "unknown"
    game_session = GameSession(id=session_id, ip_hash=hash_ip(ip))
    db.add(game_session)
    db.commit()
    db.refresh(game_session)

    response.set_cookie(
        key=COOKIE_NAME,
        value=sign(session_id),
        max_age=COOKIE_MAX_AGE_SECONDS,
        httponly=True,
        samesite="lax",
        secure=os.environ.get("COOKIE_SECURE", "true").lower() == "true",
    )
    return game_session


# --------------------------------------------------------------------------
# Pydantic response modelleri
# --------------------------------------------------------------------------


class SessionOut(BaseModel):
    target_text: str
    target_length: int
    current_index: int
    current_streak: int
    best_streak: int


class RollOut(BaseModel):
    char: str
    correct: bool
    current_index: int
    current_streak: int
    best_streak: int
    completed: bool
    is_new_personal_best: bool


class NicknameIn(BaseModel):
    nickname: str = Field(min_length=NICKNAME_MIN_LEN, max_length=NICKNAME_MAX_LEN)

    @field_validator("nickname")
    @classmethod
    def clean_nickname(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Takma ad boş olamaz.")
        if not re.fullmatch(r"[A-Za-z0-9ÇĞİÖŞÜçğıöşü _\-]{1,20}", v):
            raise ValueError("Takma ad sadece harf, rakam, boşluk, - ve _ içerebilir.")
        return v


class LeaderboardEntryOut(BaseModel):
    nickname: str
    score: int
    achieved_at: datetime


# --------------------------------------------------------------------------
# Endpoint'ler
# --------------------------------------------------------------------------


@app.post("/api/session", response_model=SessionOut)
def start_or_resume_session(game_session: GameSession = Depends(get_or_create_session)):
    """Sayfa yüklendiğinde çağrılır. Hedef metni ve mevcut ilerlemeyi döner."""
    return SessionOut(
        target_text=TARGET_TEXT,
        target_length=TARGET_LENGTH,
        current_index=game_session.current_index,
        current_streak=game_session.current_streak,
        best_streak=game_session.best_streak,
    )


@app.post("/api/roll", response_model=RollOut)
def roll(
    request: Request,
    game_session: GameSession = Depends(get_or_create_session),
    db: Session = Depends(get_db),
):
    """
    Tek bir 'zar atma' isteği: sunucu rastgele bir karakter üretir,
    hedef metindeki bir sonraki karakterle karşılaştırır ve session'ın
    ilerlemesini günceller. Dönen sonuç istemcinin ürettiği hiçbir
    veriye dayanmaz — istemci sadece isteği tetikler.
    """
    ip = request.client.host if request.client else "unknown"
    check_ip_rate_limit(ip)

    now = datetime.utcnow()
    if game_session.last_roll_at is not None:
        elapsed_ms = (now - game_session.last_roll_at).total_seconds() * 1000
        if elapsed_ms < MIN_ROLL_INTERVAL_MS:
            raise HTTPException(status_code=429, detail="Çok hızlısınız, biraz yavaşlayın.")

    # Kriptografik olarak güvenli, tahmin edilemez RNG.
    char = secrets.choice(ALPHABET)
    target_char = TARGET_TEXT[game_session.current_index]
    correct = char == target_char

    is_new_personal_best = False
    completed = False

    if correct:
        game_session.current_index += 1
        game_session.current_streak += 1
        if game_session.current_streak > game_session.best_streak:
            game_session.best_streak = game_session.current_streak
            is_new_personal_best = True
        if game_session.current_index >= TARGET_LENGTH:
            completed = True
            game_session.current_index = 0  # bir tur bitince baştan başla
    else:
        game_session.current_index = 0
        game_session.current_streak = 0

    game_session.total_rolls += 1
    game_session.last_roll_at = now

    db.add(game_session)
    db.commit()
    db.refresh(game_session)

    return RollOut(
        char=char,
        correct=correct,
        current_index=game_session.current_index,
        current_streak=game_session.current_streak,
        best_streak=game_session.best_streak,
        completed=completed,
        is_new_personal_best=is_new_personal_best,
    )


@app.get("/api/leaderboard", response_model=list[LeaderboardEntryOut])
def get_leaderboard(db: Session = Depends(get_db)):
    statement = (
        select(LeaderboardEntry)
        .join(GameSession, GameSession.id == LeaderboardEntry.session_id)
        .where(GameSession.flagged == False)  # noqa: E712
        .order_by(LeaderboardEntry.score.desc(), LeaderboardEntry.achieved_at.asc())
        .limit(LEADERBOARD_SIZE)
    )
    entries = db.exec(statement).all()
    return [LeaderboardEntryOut(nickname=e.nickname, score=e.score, achieved_at=e.achieved_at) for e in entries]


@app.get("/api/leaderboard/eligible")
def is_eligible_for_leaderboard(
    game_session: GameSession = Depends(get_or_create_session),
    db: Session = Depends(get_db),
):
    """
    Frontend, nickname modalını göstermeden önce bu endpoint'i sorar.
    Skor burada da SUNUCUDAKİ best_streak'ten okunur, istemciden değil.
    """
    count_statement = select(LeaderboardEntry)
    count = len(db.exec(count_statement).all())
    if count < LEADERBOARD_SIZE:
        eligible = game_session.best_streak > 0
        min_score = 0
    else:
        lowest = db.exec(select(LeaderboardEntry).order_by(LeaderboardEntry.score.asc())).first()
        min_score = lowest.score if lowest else 0
        eligible = game_session.best_streak > min_score
    return {"eligible": eligible, "best_streak": game_session.best_streak, "current_min_score": min_score}


@app.post("/api/leaderboard/submit", response_model=LeaderboardEntryOut)
def submit_to_leaderboard(
    payload: NicknameIn,
    game_session: GameSession = Depends(get_or_create_session),
    db: Session = Depends(get_db),
):
    """
    ÖNEMLİ: Skor buradan GELMEZ. İstemci sadece bir takma ad gönderir;
    kaydedilecek skor, o session için veritabanında zaten var olan
    best_streak değeridir. Böylece bir istemcinin "score": 999999 gibi
    bir alanı isteğe eklemesinin hiçbir anlamı yoktur.
    """
    if game_session.best_streak <= 0:
        raise HTTPException(status_code=400, detail="Henüz kaydedilecek bir seri yok.")

    existing = db.get(LeaderboardEntry, game_session.id)
    if existing:
        if game_session.best_streak <= existing.score:
            raise HTTPException(status_code=400, detail="Mevcut kaydınız zaten güncel.")
        existing.score = game_session.best_streak
        existing.nickname = payload.nickname
        existing.achieved_at = datetime.utcnow()
        db.add(existing)
        db.commit()
        db.refresh(existing)
        return LeaderboardEntryOut(nickname=existing.nickname, score=existing.score, achieved_at=existing.achieved_at)

    entry = LeaderboardEntry(
        session_id=game_session.id,
        nickname=payload.nickname,
        score=game_session.best_streak,
    )
    db.add(entry)
    db.commit()
    db.refresh(entry)
    return LeaderboardEntryOut(nickname=entry.nickname, score=entry.score, achieved_at=entry.achieved_at)


@app.on_event("startup")
def on_startup():
    SQLModel.metadata.create_all(engine)


@app.get("/api/health")
def health():
    return {"status": "ok", "target_length": TARGET_LENGTH}


# --------------------------------------------------------------------------
# Frontend'i aynı origin'den servis et (prod'da tek sunucu, CORS derdi yok)
# --------------------------------------------------------------------------
# Bu mount'un dosyanın EN SONUNDA olması gerekiyor: Starlette route'ları
# tanımlanma sırasına göre eşleştirir, bu yüzden yukarıdaki /api/* route'ları
# hep önce denenir; eşleşmeyen her şey (/, /app.js, /style.css, ...) buraya
# düşer. FRONTEND_DIR yoksa (örn. sadece API'yi test ediyorsanız) mount
# sessizce atlanır.
FRONTEND_DIR = os.environ.get("FRONTEND_DIR", "../frontend")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
