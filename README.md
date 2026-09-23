# Sonsuz Maymun Teoremi

Hamlet'in "To be, or not to be" tiradını, tek tuşla üretilen rastgele
karakterlerle baştan sona hatasız tutturmaya çalıştığın minimalist bir
oyun. Konseptin özü: her tuşa basış bağımsız bir "maymun zarı" — 27
karakterlik alfabeden (a-z + boşluk) rastgele bir karakter üretilir ve
hedef metindeki bir sonraki karakterle karşılaştırılır.

## 1. Teknoloji yığını ve neden bu seçildi

| Katman | Seçim | Neden |
|---|---|---|
| Backend | **FastAPI** (Python) | Tek dosyada temiz, tip-güvenli, async destekli, otomatik `/docs` (Swagger) çıkarır. Bu oyunun tüm mantığının backend'de olması gerektiğinden (bkz. §4), backend'in basit ve okunabilir olması kritik. |
| ORM / DB erişimi | **SQLModel** | SQLAlchemy + Pydantic'i birleştirir, model tanımı = API şeması, ekstra boilerplate yok. |
| Veritabanı | **SQLite** (geliştirme) → **PostgreSQL** (prod) | SQLite sıfır kurulumla başlamanı sağlar; `DATABASE_URL` değiştirerek tek satırda Postgres'e geçersin (SQLModel/SQLAlchemy ikisini de aynı kodla destekler). |
| Frontend | **Vanilla HTML/CSS/JS** | Tek buton + bir metin bloğu + basit bir liderlik tablosu için React/Vue gibi bir framework gereksiz ağırlık. Build adımı yok, `index.html`'i açmak yeter. İstersen aynı `app.js` mantığını birebir bir React bileşenine taşıyabilirsin — API sözleşmesi değişmez. |
| Session taşıma | **İmzalı, httpOnly cookie** (HMAC-SHA256, ek bağımlılık yok) | Kullanıcı girişsiz oynayabiliyor ama sunucu hangi ilerlemenin kime ait olduğunu güvenle biliyor. |

Bu yığın "basit, hızlı, temiz" hedefiyle seçildi: tek `pip install`,
tek `uvicorn` komutu, build adımı olmayan bir frontend.

## 2. Mimari: neden her şey backend'de yaşıyor

Bu oyunun **tek gerçek güvenlik gereksinimi** şu: istemci, hiçbir
şekilde "doğru karakter geldi" ya da "seriyi şu kadar uzattım" diye
yalan söyleyemesin. Bunu sağlamanın tek yolu, oyunun çekirdek
mantığının istemciye hiç dokunmamasıdır:

```
┌─────────────┐        POST /api/roll        ┌──────────────────────┐
│   Tarayıcı   │ ─────────────────────────────▶│       FastAPI         │
│  (sadece     │                                │                        │
│   "zar at"   │        {char, correct,        │  1) secrets.choice()  │
│   der ve     │◀────── streak, ...}            │     ile rastgele      │
│   sonucu     │                                │     karakter üret     │
│   gösterir)  │                                │  2) session'daki      │
└─────────────┘                                │     current_index'teki │
                                                 │     hedef karakterle   │
      cookie: imzalı session_id                 │     karşılaştır        │
                                                 │  3) streak/best'i DB'de│
                                                 │     güncelle           │
                                                 └───────────┬────────────┘
                                                              │
                                                    ┌─────────▼─────────┐
                                                    │  SQLite / Postgres │
                                                    │  GameSession       │
                                                    │  LeaderboardEntry  │
                                                    └────────────────────┘
```

Somut olarak:

- **Rastgele karakter** `secrets.choice()` ile, yani kriptografik
  olarak güvenli bir üreteçle sunucuda seçilir. Python'un `random`
  modülü **kullanılmaz** — o tahmin edilebilir (Mersenne Twister),
  bu oyun için yeterince güvenli değildir.
- **İlerleme (`current_index`) ve seri (`current_streak`)**
  veritabanındaki `GameSession` satırında tutulur, istemciden gelen
  hiçbir alana güvenilmez. `/api/roll` isteğinin gövdesi bile boştur —
  istemcinin gönderebileceği "ben şu karakteri tuttum" gibi bir alan
  yoktur.
- **Leaderboard'a yazılan skor**, `/api/leaderboard/submit`
  isteğinde istemciden **sadece takma ad** alır. Kaydedilecek sayı,
  o session için veritabanında zaten var olan `best_streak`
  değeridir. İstemci `{"nickname": "x", "score": 999999}` gönderse
  bile `score` alanı backend modelinde yoktur, sessizce yok sayılır.

Bu üç karar birlikte şunu garanti eder: **liderlik tablosundaki her
skor, gerçekten o kadar "zar" atılmış ve gerçekten o kadar isabet
alınmış demektir.**

## 3. API tasarımı

Tüm gövdeler JSON, tüm isteklerde `credentials: include` (cookie
taşımak için) gerekir.

| Endpoint | Metod | Açıklama |
|---|---|---|
| `/api/session` | POST | Sayfa yüklenince çağrılır. Yeni session açar ya da mevcut cookie'yi doğrulayıp devam ettirir. Hedef metni ve mevcut ilerlemeyi döner. |
| `/api/roll` | POST | Gövde yok. Sunucu rastgele karakter üretir, karşılaştırır, state'i günceller, sonucu döner. Rate limit uygulanır (bkz. §4). |
| `/api/leaderboard` | GET | İlk 50 skoru döner (skor azalan, eşitlikte önce ulaşan). İşaretlenmiş (flagged) session'lar hariç tutulur. |
| `/api/leaderboard/eligible` | GET | Mevcut session'ın `best_streak`'i tabloya girmeye yetiyor mu, sorgular. Frontend, modalı göstermeden önce bunu çağırır — ama nihai kontrol yine `submit` endpoint'indedir. |
| `/api/leaderboard/submit` | POST | Gövde: `{"nickname": "..."}`. Skor istemciden **alınmaz**, session'daki `best_streak`'ten okunur. |
| `/api/health` | GET | Basit sağlık kontrolü. |

Tam OpenAPI şeması, backend çalışırken `http://localhost:8000/docs`
adresinde otomatik üretilir.

## 4. Bot / otomatik tıklayıcı koruması — ne işe yarar, ne yaramaz

Bu oyunun doğası gereği **"hile"nin klasik anlamı yok** — kimse daha
"iyi" tahmin edemez, çünkü tahmin diye bir şey yok, saf RNG var.
Gerçek tehdit modeli şudur: **bir bot, insan hızının çok üzerinde
istek atarak, salt hesaplama gücüyle RNG'yi bin kat daha fazla
denesin ve "haksız" bir şekilde uzun bir seri yakalasın.**

Alınan önlemler ve neyi çözüp neyi çözmediği:

1. **Session başına minimum istek aralığı** (`MIN_ROLL_INTERVAL_MS`,
   varsayılan 70ms). İnsan bir düğmeye saniyede ~10-12'den fazla
   basamaz; bu limit tek bir session'ın script ile "olabildiğince
   hızlı" spam atmasını engeller. `429 Too Many Requests` döner.
2. **IP başına sliding-window limiti** (`IP_MAX_REQUESTS_PER_WINDOW`).
   Tek bir session'ı yavaşlatmak yetmez — biri yüzlerce session
   açıp paralel çalıştırabilir. Bu limit aynı IP'den gelen toplam
   isteği de sınırlar. **Not:** Bu implementasyon bellek-içi
   (`dict`) ve tek process için yeterlidir; birden fazla worker/pod
   ile prod'a çıkarken bunu **Redis tabanlı bir token bucket**'a
   taşıyın (`slowapi` + `redis` kütüphaneleri önerilir), yoksa her
   worker kendi sayacını tutar ve limit etkisiz kalır.
3. **Session cookie'si HMAC ile imzalı, `httpOnly`, `SameSite=Lax`.**
   İstemci session_id'yi tahmin edip başka birinin ilerlemesini
   çalamaz ya da sahte bir session_id uydurup direkt veritabanına
   satır enjekte edemez.
4. **Leaderboard skoru asla istemciden gelmez** (§2'de anlatıldı) —
   bu, "gerçekten oynamadan skor girme" vektörünü tamamen kapatır.
5. **Takma ad girdisi whitelist regex ile doğrulanır**
   (`[A-Za-z0-9ÇĞİÖŞÜçğıöşü _-]{1,20}`), XSS/HTML enjeksiyonuna
   kapalıdır; frontend zaten `escapeHtml` ile render eder (iki
   katmanlı savunma).
6. **`flagged` alanı** — ileri seviye bir iyileştirme olarak,
   `last_roll_at` zaman damgalarının varyansı anormal derecede düşükse
   (bot gibi mekanik düzenlilik) bu alanı `True` yapıp session'ı
   leaderboard'dan sessizce gizleyebilirsiniz (kullanıcıyı
   uyarmadan — "shadow ban"). Bu depoda temel iskelet var
   (`GameSession.flagged`, leaderboard sorgusu bunu filtreliyor);
   anomali tespiti mantığının kendisi eklenmedi, çünkü gerçek
   davranış verisi olmadan güvenilir bir eşik belirlemek zor —
   canlıya çıktıktan sonra `last_roll_at` dağılımına bakıp
   ayarlamanızı öneririm.
7. **Opsiyonel, eklemediğimiz ama önerilen:** Yeni session
   oluştururken (`/api/session`) bir CAPTCHA (Cloudflare Turnstile
   gibi görünmez, kullanıcı deneyimini bozmayan bir seçenek) istemek,
   otomatik "session farming"i pahalılaştırır.

Dürüst olmak gerekirse: bu oyun kavramsal olarak "sonsuz sayıda
maymun" fikrine dayandığından, **çok sayıda gerçek denemeyle uzun bir
seri elde etmek "hile" değil, oyunun ta kendisidir.** Anti-cheat'in
amacı bunu imkansız kılmak değil, tek bir aktörün endüstriyel ölçekte
(saniyede binlerce istek) bunu bedavaya yapmasını ve **sahte skor
girişini** engellemektir.

## 5. Kurulum ve çalıştırma

### Backend

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                # SECRET_KEY'i mutlaka değiştirin
export $(cat .env | xargs)          # ya da python-dotenv kullanın
uvicorn main:app --reload --port 8000
```

Sağlık kontrolü: `curl http://localhost:8000/api/health`

### Frontend

`frontend/app.js`'teki `API_BASE` varsayılan olarak boştur — yani
"aynı origin" (prod'da backend, frontend'i kendi servis eder, bkz.
§8 DEPLOY.md). Frontend'i backend'den ayrı bir statik sunucudan
çalıştırıyorsanız (bu bölümdeki gibi), `index.html`'e `app.js`'ten
**önce** şunu ekleyin:

```html
<script>window.MONKEY_API_BASE = "http://localhost:8000";</script>
```
Ardından statik bir sunucuyla açın (doğrudan `file://` ile açmak
cookie/CORS davranışını bozabilir):

```bash
cd frontend
python3 -m http.server 5500
```

Tarayıcıda `http://localhost:5500` adresine gidin. Backend'deki
`FRONTEND_ORIGINS` ortam değişkeninin bu adresi içerdiğinden emin
olun (varsayılan zaten `localhost:5500` içeriyor).

## 6. Yayına alma (tek ücretsiz VM ile)

`monkeyswritehamlet.com` gibi bir domain alıp bunu neredeyse sıfır
maliyetle yayınlamak istiyorsanız adım adım **[DEPLOY.md](DEPLOY.md)**'ye
bakın: kodu GitHub'a atma, Squarespace'ten domain alma, Oracle Cloud'un
süresiz ücretsiz VM'inde barındırma, `Dockerfile` + `docker-compose.yml`
ile tek komutla ayağa kaldırma, nginx + Let's Encrypt ile HTTPS ve
`main`'e her push'ta VM'i otomatik güncelleyen bir GitHub Actions
workflow'u. Bu depoda zaten hazır:

- `Dockerfile` — backend + frontend'i tek imajda paketler, SQLite'ı `/data`'ya (kalıcı volume) yazar.
- `docker-compose.yml` — `.env`'den `SECRET_KEY` okur, portu sadece `127.0.0.1`'e açar (dışarıya tek kapı nginx olsun diye).
- `deploy/nginx.conf.example` — certbot'un SSL için düzenleyeceği başlangıç config'i.
- `.github/workflows/deploy.yml` — `main`'e push'ta VM'e SSH'lanıp `git pull` + `docker compose up -d --build` çalıştırır (secrets kurulumu DEPLOY.md §6'da).
- `.gitignore` — `.env`, `monkey.db`, `data/` gibi commit'lenmemesi gereken dosyaları dışarıda bırakır.

Bu kurulumda (tek VM, düşük trafik) `DATABASE_URL`'i Postgres'e
çevirmenize ya da IP rate limiter'ı Redis'e taşımanıza **gerek yok**
— tek process, tek disk, sorun değil. Eğer ileride birden fazla
worker/instance'a (`uvicorn --workers N` ya da birden fazla makine)
çıkarsanız, IP rate limiter'ın bellek-içi sözlüğü worker'lar arasında
paylaşılmayacağından Redis tabanlı bir çözüme geçmeniz gerekir.

Ayrıca dikkat edilmesi gerekenler:

- `SECRET_KEY`'i `python -c "import secrets; print(secrets.token_hex(32))"` ile üretin, koda gömmeyin (`.env` dosyasında tutulur, `.gitignore`'a ekleyin).
- `COOKIE_SECURE=true` kalsın (HTTPS zorunlu hale gelir).
- CORS'ta `FRONTEND_ORIGINS`'i gerçek domain'inizle sınırlayın, `*` kullanmayın.
- Gerçek istemci IP'sinin nginx arkasında da doğru okunması için `Dockerfile`'daki `uvicorn --proxy-headers --forwarded-allow-ips=*` bayrakları zaten ayarlı — bunu değiştirmeyin, yoksa tüm istekler tek bir IP'den geliyormuş gibi görünür ve IP rate limit işe yaramaz hale gelir.

## 7. Dosya yapısı

```
monkey-typewriter/
├── .github/
│   └── workflows/
│       └── deploy.yml       # main'e push'ta VM'i otomatik günceller
├── backend/
│   ├── main.py              # Tüm API — modeller, endpoint'ler, rate limiting, StaticFiles mount
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html            # Üstte "yazdıklarımız" şeridi, altta Hamlet referans metni
│   ├── style.css             # Retro daktilo teması
│   └── app.js                # Sadece görüntüleme + istek tetikleme
├── deploy/
│   └── nginx.conf.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── DEPLOY.md                 # GitHub'a atma + monkeyswritehamlet.com'u ücretsiz VM'e yayınlama rehberi
└── README.md
```
