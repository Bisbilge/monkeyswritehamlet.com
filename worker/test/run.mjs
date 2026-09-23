// Worker'ın iş mantığını gerçek bir Cloudflare hesabı / wrangler dev
// olmadan doğrulayan hafif bir test koşucusu. `node test/run.mjs` ile
// çalıştırılır (bkz. package.json'a eklenmedi çünkü CI'de otomatik
// çalışmıyor — elle/geliştirme sırasında çalıştırmak için).

import assert from "node:assert/strict";
import worker from "../src/index.js";
import { TARGET_TEXT, ALPHABET } from "../src/index.js";
import { createMockD1 } from "./mock-d1.mjs";

const ORIGIN = "http://localhost:5500";

function makeEnv(overrides = {}) {
  return {
    DB: createMockD1(),
    SECRET_KEY: "test-secret-key-not-for-prod",
    FRONTEND_ORIGINS: ORIGIN,
    ...overrides,
  };
}

function req(path, { method = "GET", cookie, body, ip = "203.0.113.1" } = {}) {
  const headers = { Origin: ORIGIN, "CF-Connecting-IP": ip };
  if (cookie) headers["Cookie"] = `monkey_session=${cookie}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`https://monkey-api.example.workers.dev${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function extractCookie(res) {
  const raw = res.headers.get("set-cookie");
  if (!raw) return null;
  const match = raw.match(/monkey_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err });
  }
}

// --------------------------------------------------------------------------

await test("hedef metin normalize edilmiş ve boş değil", async () => {
  assert.ok(TARGET_TEXT.length > 100);
  assert.ok(/^[a-z ]+$/.test(TARGET_TEXT));
});

await test("POST /api/session yeni bir session açar ve cookie set eder", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("/api/session", { method: "POST" }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.current_index, 0);
  assert.equal(body.current_streak, 0);
  assert.equal(body.target_text, TARGET_TEXT);
  const cookie = extractCookie(res);
  assert.ok(cookie, "Set-Cookie başlığı bekleniyordu");
  const setCookieHeader = res.headers.get("set-cookie");
  assert.match(setCookieHeader, /SameSite=None/);
  assert.match(setCookieHeader, /Secure/);
  assert.match(setCookieHeader, /HttpOnly/);
});

await test("aynı cookie ile ikinci /api/session yeni cookie SET ETMEZ (mevcut session'ı döner)", async () => {
  const env = makeEnv();
  const first = await worker.fetch(req("/api/session", { method: "POST" }), env);
  const cookie = extractCookie(first);
  const second = await worker.fetch(req("/api/session", { method: "POST", cookie }), env);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("set-cookie"), null);
});

await test("bozuk/imzasız cookie kabul edilmez, yeni session açılır", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("/api/session", { method: "POST", cookie: "forged-id.deadbeef" }), env);
  assert.equal(res.status, 200);
  assert.ok(extractCookie(res), "sahte cookie reddedilip yeni bir session açılmalıydı");
});

await test("/api/roll: her karakter ALPHABET içinde ve doğruluk mantığı tutarlı (200 atış)", async () => {
  const env = makeEnv();
  const session = await worker.fetch(req("/api/session", { method: "POST" }), env);
  let cookie = extractCookie(session);
  let expectedIndex = 0;
  let expectedStreak = 0;
  let expectedBest = 0;

  for (let i = 0; i < 40; i++) {
    // Worker'daki MIN_ROLL_INTERVAL_MS=70ms'e takılmamak için her atış
    // arasında biraz bekliyoruz (gerçek bir tarayıcıda tuşa basış hızı da
    // zaten bunun altında kalmıyor).
    await new Promise((r) => setTimeout(r, 75));
    const res = await worker.fetch(req("/api/roll", { method: "POST", cookie, ip: "198.51.100.1" }), env);
    assert.equal(res.status, 200, `roll #${i} beklenmedik status`);
    const body = await res.json();
    assert.ok(ALPHABET.includes(body.char), "üretilen karakter alfabede olmalı");

    if (body.correct) {
      expectedStreak += 1;
      expectedIndex += 1;
      if (expectedStreak > expectedBest) expectedBest = expectedStreak;
      if (expectedIndex >= TARGET_TEXT.length) {
        expectedIndex = 0;
        assert.equal(body.completed, true);
      }
    } else {
      expectedStreak = 0;
      expectedIndex = 0;
    }

    assert.equal(body.current_index, expectedIndex, `roll #${i}: current_index uyuşmuyor`);
    assert.equal(body.current_streak, expectedStreak, `roll #${i}: current_streak uyuşmuyor`);
    assert.equal(body.best_streak, expectedBest, `roll #${i}: best_streak uyuşmuyor`);
  }
});

await test("session-içi rate limit: art arda hızlı iki roll 429 döner", async () => {
  const env = makeEnv();
  const session = await worker.fetch(req("/api/session", { method: "POST" }), env);
  const cookie = extractCookie(session);
  const r1 = await worker.fetch(req("/api/roll", { method: "POST", cookie, ip: "198.51.100.2" }), env);
  assert.equal(r1.status, 200);
  const r2 = await worker.fetch(req("/api/roll", { method: "POST", cookie, ip: "198.51.100.2" }), env);
  assert.equal(r2.status, 429, "70ms içinde ikinci roll 429 dönmeliydi");
  const body = await r2.json();
  assert.match(body.detail, /hızlı/i);
});

await test("IP rate limit: aynı IP'den 40'tan fazla hızlı istek 429 döner", async () => {
  const env = makeEnv();
  let sawLimit = false;
  for (let i = 0; i < 60; i++) {
    // Her istek cookie'siz -> her seferinde yeni session -> session-içi
    // limite takılmadan sadece IP limitini test ediyoruz.
    const res = await worker.fetch(req("/api/roll", { method: "POST", ip: "198.51.100.99" }), env);
    if (res.status === 429) {
      const body = await res.json();
      if (/fazla istek/i.test(body.detail)) {
        sawLimit = true;
        break;
      }
    }
  }
  assert.ok(sawLimit, "40 isteğin üzerinde IP rate limit tetiklenmeliydi");
});

await test("leaderboard: best_streak <= 0 iken submit 400 döner", async () => {
  const env = makeEnv();
  const session = await worker.fetch(req("/api/session", { method: "POST" }), env);
  const cookie = extractCookie(session);
  const res = await worker.fetch(
    req("/api/leaderboard/submit", { method: "POST", cookie, body: { nickname: "test" } }),
    env
  );
  assert.equal(res.status, 400);
});

await test("leaderboard: geçersiz takma ad reddedilir (422)", async () => {
  const env = makeEnv();
  const session = await worker.fetch(req("/api/session", { method: "POST" }), env);
  const cookie = extractCookie(session);
  const res = await worker.fetch(
    req("/api/leaderboard/submit", { method: "POST", cookie, body: { nickname: "<script>alert(1)</script>" } }),
    env
  );
  assert.equal(res.status, 422);
});

await test("leaderboard: gerçek bir best_streak ile submit çalışır ve skor SUNUCUDAN gelir (istemci score gönderse bile yok sayılır)", async () => {
  const env = makeEnv();
  const session = await worker.fetch(req("/api/session", { method: "POST" }), env);
  const cookie = extractCookie(session);

  // Deterministik olması için crypto.getRandomValues'i geçici olarak
  // "her zaman hedef karakteri üret" şeklinde sahteleştiriyoruz — bu SADECE
  // testin kendi güvenilirliği için; worker kodunun kendisi değişmiyor.
  const originalGetRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  let idx = 0;
  globalThis.crypto.getRandomValues = (arr) => {
    const targetChar = TARGET_TEXT[idx % TARGET_TEXT.length];
    const charIdx = ALPHABET.indexOf(targetChar);
    arr[0] = charIdx; // n=27 << 2^32 olduğu için reddetme döngüsüne girmez
    idx++;
    return arr;
  };

  try {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 75));
      const res = await worker.fetch(req("/api/roll", { method: "POST", cookie, ip: "198.51.100.3" }), env);
      const body = await res.json();
      assert.equal(body.correct, true, `roll #${i} hedef karakter üretilmiş olmalıydı`);
    }
  } finally {
    globalThis.crypto.getRandomValues = originalGetRandomValues;
  }

  const submitRes = await worker.fetch(
    req("/api/leaderboard/submit", {
      method: "POST",
      cookie,
      body: { nickname: "Bilge", score: 999999 }, // score alanı sunucuda okunmuyor
    }),
    env
  );
  assert.equal(submitRes.status, 200);
  const submitBody = await submitRes.json();
  assert.equal(submitBody.score, 5, "skor istemcinin gönderdiği 999999 DEĞİL, gerçek best_streak (5) olmalı");

  const lbRes = await worker.fetch(req("/api/leaderboard"), env);
  const lb = await lbRes.json();
  assert.equal(lb.length, 1);
  assert.equal(lb[0].nickname, "Bilge");
  assert.equal(lb[0].score, 5);
});

await test("CORS: izinli olmayan origin'e Access-Control-Allow-Origin dönülmez", async () => {
  const env = makeEnv();
  const request = new Request("https://monkey-api.example.workers.dev/api/health", {
    headers: { Origin: "https://evil.example.com" },
  });
  const res = await worker.fetch(request, env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
});

await test("CORS: izinli origin'e doğru header'lar dönülür", async () => {
  const env = makeEnv();
  const res = await worker.fetch(req("/api/health"), env);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(res.headers.get("Access-Control-Allow-Credentials"), "true");
});

// --------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}`);
  if (!r.ok) console.log("   " + (r.err.stack || r.err.message).split("\n").join("\n   "));
}
console.log(`\n${results.length - failed.length}/${results.length} test geçti.`);
if (failed.length > 0) process.exit(1);
