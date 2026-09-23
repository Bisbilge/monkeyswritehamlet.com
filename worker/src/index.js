/**
 * Sonsuz Maymun Teoremi — Backend (Cloudflare Worker + D1)
 * =========================================================
 *
 * Bu dosya, projenin backend/main.py'deki FastAPI sürümüyle AYNI anti-cheat
 * mimarisinin serverless (ücretsiz) bir portudur. Değişen sadece çalışma
 * ortamı (Python/uvicorn yerine V8 izole worker) ve depolama (SQLite dosyası
 * yerine Cloudflare D1) — oyunun güvenlik garantileri birebir korunuyor:
 *
 *   - Rastgele karakter sunucuda, kriptografik olarak güvenli bir üreteçle
 *     (crypto.getRandomValues, reddetme örneklemesiyle bias'sız) seçilir.
 *     İstemci hangi karakterin üretileceğini ASLA etkileyemez.
 *   - "Doğru mu?" karşılaştırması, ilerleme (current_index) ve seri (streak)
 *     D1'de, imzalı bir session cookie'sine bağlı olarak tutulur. İstemci
 *     sadece "zar at" der, sonucu okur.
 *   - Leaderboard'a yazılan skor, istemcinin gönderdiği bir sayı DEĞİL, o
 *     session için D1'de biriken best_streak değeridir.
 *
 * Frontend artık ayrı bir origin'den (GitHub Pages) servis edildiği için
 * (backend'in kendisi de ayrı bir origin'den, *.workers.dev) bu sürüm
 * CORS + SameSite=None; Secure çerez kullanır — FastAPI sürümündeki
 * "aynı origin" StaticFiles mount'unun yerini bu alıyor.
 */

// --------------------------------------------------------------------------
// Yapılandırma
// --------------------------------------------------------------------------

const COOKIE_NAME = "monkey_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 gün

// Bir session'ın art arda iki "roll" isteği arasında olması gereken minimum
// süre. İnsan bir düğmeye saniyede 10-12'den fazla tıklayamaz; 70ms ~
// saniyede ~14 istek üst sınırı koyar (cömert ama script'lerin
// "olabildiğince hızlı" spam atmasını engeller).
const MIN_ROLL_INTERVAL_MS = 70;

// IP başına kaba bir sliding-window limiti: tek bir IP'nin çok sayıda
// session açıp paralel "farm" yapmasını zorlaştırır. D1'deki ip_hit
// tablosunda tutulur (bkz. schema.sql) — tek process bekleyen bellek-içi
// bir dict yerine, Worker'ın çoklu edge lokasyonlarında da tutarlı çalışır.
const IP_WINDOW_SECONDS = 10;
const IP_MAX_REQUESTS_PER_WINDOW = 40;

const LEADERBOARD_SIZE = 50;
const NICKNAME_MAX_LEN = 20;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz "; // 27 karakter (26 harf + boşluk)

// --------------------------------------------------------------------------
// Hedef metin — Hamlet, "To be, or not to be" tiradı
// --------------------------------------------------------------------------

const RAW_TARGET_TEXT = `
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
`;

function normalizeText(text) {
  text = text.toLowerCase();
  text = text.replace(/[-–—\n\r\t]/g, " "); // tire/satır -> boşluk
  text = text.replace(/[^a-z ]/g, ""); // noktalama/apostrof -> silinir
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

const TARGET_TEXT = normalizeText(RAW_TARGET_TEXT);
const TARGET_LENGTH = TARGET_TEXT.length;

// --------------------------------------------------------------------------
// Yardımcılar: JSON yanıt, hata sınıfı
// --------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// --------------------------------------------------------------------------
// Session cookie imzalama (Web Crypto HMAC-SHA256 — harici bağımlılık yok)
// --------------------------------------------------------------------------

function bufToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function signSession(sessionId, secret) {
  const key = await hmacKey(secret);
  const enc = new TextEncoder();
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(sessionId));
  return `${sessionId}.${bufToHex(sig)}`;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

async function verifySession(token, secret) {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx === -1) return null;
  const sessionId = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const resigned = await signSession(sessionId, secret);
  const expectedMac = resigned.slice(resigned.lastIndexOf(".") + 1);
  if (!timingSafeEqual(mac, expectedMac)) return null;
  return sessionId;
}

async function hashIp(ip, secret) {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(secret + ip));
  return bufToHex(digest).slice(0, 16);
}

// --------------------------------------------------------------------------
// Kriptografik olarak güvenli, bias'sız karakter seçimi
// --------------------------------------------------------------------------
// Python'un secrets.choice()'u da aynı prensiple (reddetme örneklemesi)
// çalışır: basit `random() % n` modulo bias üretir (n, 2^32'yi tam
// bölmüyorsa); bunu önlemek için 2^32'nin n'e tam bölünen en büyük
// katının üstünde kalan değerleri reddediyoruz.

function randomChar() {
  const n = ALPHABET.length;
  const max = Math.floor(0x100000000 / n) * n;
  const arr = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(arr);
    x = arr[0];
  } while (x >= max);
  return ALPHABET[x % n];
}

// --------------------------------------------------------------------------
// Cookie parse / oluşturma
// --------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

function buildSetCookie(signedValue) {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(signedValue)}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    // Frontend (GitHub Pages) ve backend (*.workers.dev) artık farklı
    // origin'ler olduğu için SameSite=None şart — Lax/Strict, cross-site
    // fetch isteklerinde çerezin gitmesini engeller. Secure zaten zorunlu
    // kılıyor bunu (ikisi de HTTPS üzerinden çalışıyor).
    "SameSite=None",
  ].join("; ");
}

// --------------------------------------------------------------------------
// CORS
// --------------------------------------------------------------------------

function buildCorsHeaders(origin, allowedOrigins) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

// --------------------------------------------------------------------------
// D1 erişimi: session al/oluştur
// --------------------------------------------------------------------------

async function getOrCreateSession(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const raw = cookies[COOKIE_NAME];
  let sessionId = raw ? await verifySession(raw, env.SECRET_KEY) : null;
  let session = null;

  if (sessionId) {
    session = await env.DB.prepare("SELECT * FROM game_session WHERE id = ?").bind(sessionId).first();
  }

  if (session) {
    return { session, isNew: false };
  }

  sessionId = crypto.randomUUID().replace(/-/g, "");
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipHash = await hashIp(ip, env.SECRET_KEY);
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO game_session
      (id, current_index, current_streak, best_streak, total_rolls, created_at, last_roll_at, ip_hash, flagged)
     VALUES (?, 0, 0, 0, 0, ?, NULL, ?, 0)`
  )
    .bind(sessionId, now, ipHash)
    .run();

  session = {
    id: sessionId,
    current_index: 0,
    current_streak: 0,
    best_streak: 0,
    total_rolls: 0,
    created_at: now,
    last_roll_at: null,
    ip_hash: ipHash,
    flagged: 0,
  };

  return { session, isNew: true };
}

async function attachSessionCookie(res, session, isNew, env) {
  if (isNew) {
    const signed = await signSession(session.id, env.SECRET_KEY);
    res.headers.append("Set-Cookie", buildSetCookie(signed));
  }
  return res;
}

// --------------------------------------------------------------------------
// IP başına D1 tabanlı sliding-window rate limiter
// --------------------------------------------------------------------------
// Bellek-içi bir dict yerine D1 kullanıyoruz çünkü Worker isolate'leri
// istekler arasında yeniden kullanılacağı garanti değildir (farklı edge
// lokasyonlarına düşebilir). D1, tüm istekler için tutarlı tek bir görünüm
// sağlar. Küçük ölçekli bir hobi projesi için üç sorgu/roll kabul edilebilir
// bir maliyet.

async function checkIpRateLimit(env, ip) {
  const nowMs = Date.now();
  const windowStart = nowMs - IP_WINDOW_SECONDS * 1000;
  await env.DB.prepare("DELETE FROM ip_hit WHERE ip = ? AND ts < ?").bind(ip, windowStart).run();
  const row = await env.DB.prepare("SELECT COUNT(*) as c FROM ip_hit WHERE ip = ?").bind(ip).first();
  const count = row ? row.c : 0;
  if (count >= IP_MAX_REQUESTS_PER_WINDOW) {
    return false;
  }
  await env.DB.prepare("INSERT INTO ip_hit (ip, ts) VALUES (?, ?)").bind(ip, nowMs).run();
  return true;
}

// --------------------------------------------------------------------------
// Takma ad doğrulama
// --------------------------------------------------------------------------

function validateNickname(v) {
  if (typeof v !== "string") throw new HttpError(422, "Takma ad gerekli.");
  v = v.trim();
  if (v.length < 1 || v.length > NICKNAME_MAX_LEN) {
    throw new HttpError(422, "Takma ad 1-20 karakter olmalı.");
  }
  if (!/^[A-Za-z0-9ÇĞİÖŞÜçğıöşü _-]{1,20}$/.test(v)) {
    throw new HttpError(422, "Takma ad sadece harf, rakam, boşluk, - ve _ içerebilir.");
  }
  return v;
}

// --------------------------------------------------------------------------
// Endpoint handler'ları
// --------------------------------------------------------------------------

async function handleSession(request, env) {
  const { session, isNew } = await getOrCreateSession(request, env);
  const res = json({
    target_text: TARGET_TEXT,
    target_length: TARGET_LENGTH,
    current_index: session.current_index,
    current_streak: session.current_streak,
    best_streak: session.best_streak,
  });
  return attachSessionCookie(res, session, isNew, env);
}

async function handleRoll(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const allowed = await checkIpRateLimit(env, ip);
  if (!allowed) throw new HttpError(429, "Çok fazla istek. Biraz yavaşlayın.");

  const { session, isNew } = await getOrCreateSession(request, env);

  const nowMs = Date.now();
  if (session.last_roll_at) {
    const elapsed = nowMs - Date.parse(session.last_roll_at);
    if (elapsed < MIN_ROLL_INTERVAL_MS) {
      throw new HttpError(429, "Çok hızlısınız, biraz yavaşlayın.");
    }
  }

  // Kriptografik olarak güvenli, tahmin edilemez RNG — istemci bu değeri
  // hiçbir şekilde etkileyemez ya da önceden bilemez.
  const char = randomChar();
  const targetChar = TARGET_TEXT[session.current_index];
  const correct = char === targetChar;

  let newIndex = session.current_index;
  let newStreak = session.current_streak;
  let newBest = session.best_streak;
  let isNewBest = false;
  let completed = false;

  if (correct) {
    newIndex += 1;
    newStreak += 1;
    if (newStreak > newBest) {
      newBest = newStreak;
      isNewBest = true;
    }
    if (newIndex >= TARGET_LENGTH) {
      completed = true;
      newIndex = 0; // bir tur bitince baştan başla
    }
  } else {
    newIndex = 0;
    newStreak = 0;
  }

  const nowIso = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `UPDATE game_session
     SET current_index = ?, current_streak = ?, best_streak = ?, total_rolls = total_rolls + 1, last_roll_at = ?
     WHERE id = ?`
  )
    .bind(newIndex, newStreak, newBest, nowIso, session.id)
    .run();

  const res = json({
    char,
    correct,
    current_index: newIndex,
    current_streak: newStreak,
    best_streak: newBest,
    completed,
    is_new_personal_best: isNewBest,
  });
  return attachSessionCookie(res, session, isNew, env);
}

async function handleLeaderboard(env) {
  const { results } = await env.DB.prepare(
    `SELECT le.nickname as nickname, le.score as score, le.achieved_at as achieved_at
     FROM leaderboard_entry le
     JOIN game_session gs ON gs.id = le.session_id
     WHERE gs.flagged = 0
     ORDER BY le.score DESC, le.achieved_at ASC
     LIMIT ?`
  )
    .bind(LEADERBOARD_SIZE)
    .all();
  return json((results || []).map((r) => ({ nickname: r.nickname, score: r.score, achieved_at: r.achieved_at })));
}

async function handleEligible(request, env) {
  const { session, isNew } = await getOrCreateSession(request, env);
  const countRow = await env.DB.prepare("SELECT COUNT(*) as c FROM leaderboard_entry").first();
  const count = countRow ? countRow.c : 0;

  let eligible;
  let minScore;
  if (count < LEADERBOARD_SIZE) {
    eligible = session.best_streak > 0;
    minScore = 0;
  } else {
    const lowest = await env.DB.prepare("SELECT score FROM leaderboard_entry ORDER BY score ASC LIMIT 1").first();
    minScore = lowest ? lowest.score : 0;
    eligible = session.best_streak > minScore;
  }

  const res = json({ eligible, best_streak: session.best_streak, current_min_score: minScore });
  return attachSessionCookie(res, session, isNew, env);
}

async function handleSubmit(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    throw new HttpError(400, "Geçersiz istek gövdesi.");
  }
  const nickname = validateNickname(payload && payload.nickname);

  const { session, isNew } = await getOrCreateSession(request, env);
  if (session.best_streak <= 0) {
    throw new HttpError(400, "Henüz kaydedilecek bir seri yok.");
  }

  // ÖNEMLİ: Skor buradan GELMEZ. İstemci sadece bir takma ad gönderir;
  // kaydedilecek skor, o session için D1'de zaten var olan best_streak
  // değeridir. Bir istemcinin isteğe "score": 999999 gibi bir alan
  // eklemesinin hiçbir anlamı yoktur — payload'dan zaten okunmuyor.
  const existing = await env.DB.prepare("SELECT * FROM leaderboard_entry WHERE session_id = ?")
    .bind(session.id)
    .first();
  const nowIso = new Date().toISOString();

  if (existing) {
    if (session.best_streak <= existing.score) {
      throw new HttpError(400, "Mevcut kaydınız zaten güncel.");
    }
    await env.DB.prepare("UPDATE leaderboard_entry SET score = ?, nickname = ?, achieved_at = ? WHERE session_id = ?")
      .bind(session.best_streak, nickname, nowIso, session.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO leaderboard_entry (session_id, nickname, score, achieved_at) VALUES (?, ?, ?, ?)"
    )
      .bind(session.id, nickname, session.best_streak, nowIso)
      .run();
  }

  const res = json({ nickname, score: session.best_streak, achieved_at: nowIso });
  return attachSessionCookie(res, session, isNew, env);
}

// --------------------------------------------------------------------------
// Router
// --------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowedOrigins = (env.FRONTEND_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const corsHeaders = buildCorsHeaders(origin, allowedOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    let response;
    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        response = json({ status: "ok", target_length: TARGET_LENGTH });
      } else if (url.pathname === "/api/session" && request.method === "POST") {
        response = await handleSession(request, env);
      } else if (url.pathname === "/api/roll" && request.method === "POST") {
        response = await handleRoll(request, env);
      } else if (url.pathname === "/api/leaderboard" && request.method === "GET") {
        response = await handleLeaderboard(env);
      } else if (url.pathname === "/api/leaderboard/eligible" && request.method === "GET") {
        response = await handleEligible(request, env);
      } else if (url.pathname === "/api/leaderboard/submit" && request.method === "POST") {
        response = await handleSubmit(request, env);
      } else {
        response = json({ detail: "Not found" }, 404);
      }
    } catch (err) {
      if (err instanceof HttpError) {
        response = json({ detail: err.detail }, err.status);
      } else {
        response = json({ detail: "Internal error" }, 500);
      }
    }

    for (const [k, v] of Object.entries(corsHeaders)) {
      response.headers.set(k, v);
    }
    return response;
  },
};

export { TARGET_TEXT, TARGET_LENGTH, normalizeText, randomChar, signSession, verifySession, ALPHABET };
