# Sonsuz Maymun Teoremi

Hamlet'in "To be, or not to be" tiradını, tek tuşla üretilen rastgele
karakterlerle baştan sona hatasız tutturmaya çalıştığın minimalist bir
oyun. Konseptin özü: her tuşa basış bağımsız bir "maymun zarı" — 27
karakterlik alfabeden (a-z + boşluk) rastgele bir karakter üretilir ve
hedef metindeki bir sonraki karakterle karşılaştırılır.

## 1. Teknoloji yığını ve neden bu seçildi

Proje **tamamen ücretsiz ve sadece GitHub üzerinden** yayınlanabilsin diye
iki parçaya ayrılıyor:

| Katman | Seçim | Neden |
|---|---|---|
| Backend (birincil, önerilen) | **Cloudflare Worker + D1** (`worker/`) | GitHub Pages statik dosya dışında bir şey çalıştıramadığı için sunucu mantığı serverless bir platforma taşındı. Cloudflare'ın ücretsiz katmanı kredi kartı istemez, uykuya dalmaz, günde 100.000 istek/gün kotası bu boyuttaki bir proje için fazlasıyla yeterli. D1, SQLite uyumlu, 5GB'a kadar ücretsiz. |
| Backend (alternatif, kendi sunucunuzda barındırmak isterseniz) | **FastAPI** (Python, `backend/`) | Aynı mantığın Python/SQLModel karşılığı — bir VM'de (örn. Oracle Cloud Always Free) kendi sunucunuzu işletmek isterseniz hâlâ burada duruyor, ama artık ana yol değil. |
| ORM / DB erişimi | Worker: ham SQL (D1) · FastAPI: **SQLModel** | Worker tarafında D1'in kendi `prepare()/bind()` API'si kullanılıyor (bkz. `worker/src/index.js`); FastAPI tarafında SQLAlchemy + Pydantic'i birleştiren SQLModel. |
| Frontend | **Vanilla HTML/CSS/JS** | Tek buton + bir metin bloğu + basit bir liderlik tablosu için React/Vue gibi bir framework gereksiz ağırlık. Build adımı yok, `index.html`'i açmak yeter. GitHub Pages'te statik olarak servis edilir. |
| Session taşıma | **İmzalı, httpOnly cookie** (HMAC-SHA256, ek bağımlılık yok — Worker tarafında Web Crypto `crypto.subtle`, FastAPI tarafında Python `hmac`) | Kullanıcı girişsiz oynayabiliyor ama sunucu hangi ilerlemenin kime ait olduğunu güvenle biliyor. Frontend ve backend artık farklı origin'lerde olduğu için (`github.io` / `workers.dev`) çerez `SameSite=None; Secure` ile taşınıyor. |

`worker/src/index.js`, `backend/main.py`'nin mantığının birebir JavaScript
portudur — anti-cheat garantileri (bkz. §2 ve §4) ikisinde de aynıdır,
sadece çalışma zamanı ve depolama farklı. Yayına almak için hangi yolu
izleyeceğiniz **[DEPLOY.md](DEPLOY.md)**'de anlatılıyor (varsayılan ve
önerilen: Cloudflare Worker + GitHub Pages, $0 maliyet).

## 2. Mimari: neden her şey backend'de yaşıyor

Bu oyunun **tek gerçek güvenlik gereksinimi** şu: istemci, hiçbir
şekilde "doğru karakter geldi" ya da "seriyi şu kadar uzattım" diye
yalan söyleyemesin. Bunu sağlamanın tek yolu, oyunun çekirdek
mantığının istemciye hiç dokunmamasıdır:

```
┌─────────────┐   POST /api/roll (cross-origin)   ┌───────────────────────┐
│ Tarayıcı     │ ──────────────────────────────────▶│  Cloudflare Worker    │
│ (GitHub      │                                     │  (worker/src/index.js)│
│  Pages'te    │        {char, correct,             │  1) crypto.getRandom  │
│  sadece      │◀────── streak, ...}                 │     Values ile        │
│  "zar at"    │                                     │     bias'sız rastgele │
│  der ve      │                                     │     karakter üret     │
│  sonucu      │                                     │  2) session'daki      │
│  gösterir)   │                                     │     current_index'teki│
└─────────────┘                                     │     hedef karakterle   │
                                                       │     karşılaştır        │
      cookie: imzalı session_id (SameSite=None)       │  3) streak/best'i D1'de│
                                                       │     güncelle           │
                                                       └───────────┬────────────┘
                                                                    │
                                                          ┌─────────▼─────────┐
                                                          │  Cloudflare D1     │
                                                          │  game_session      │
                                                          │  leaderboard_entry │
                                                          └────────────────────┘
```

(`backend/main.py`'yi kendi sunucunuzda çalıştırırsanız aynı diyagram
geçerli — sadece "Cloudflare Worker" yerine "FastAPI" ve "D1" yerine
"SQLite/Postgres" okuyun; mantık birebir aynı.)

Somut olarak:

- **Rastgele karakter**, kriptografik olarak güvenli bir üreteçle
  sunucuda seçilir: Worker'da `crypto.getRandomValues()` + reddetme
  örneklemesiyle bias'sız seçim (bkz. `worker/src/index.js` içindeki
  `randomChar()`), FastAPI'de `secrets.choice()`. İkisi de Python'un
  `random` modülüne (tahmin edilebilir Mersenne Twister) karşılık
  **kullanılmaz**.
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
   isteği de sınırlar. Cloudflare Worker sürümünde bu D1'deki `ip_hit`
   tablosunda tutulur (bkz. `worker/schema.sql`) — bellek-içi bir
   `dict` değil, bu yüzden Worker'ın hangi edge lokasyonuna düştüğünden
   bağımsız olarak tutarlıdır. FastAPI (alternatif self-host)
   sürümünde ise hâlâ bellek-içi bir `dict` — tek process için
   yeterlidir, birden fazla worker/pod'a çıkarken **Redis tabanlı bir
   token bucket**'a taşıyın (`slowapi` + `redis` kütüphaneleri
   önerilir).
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

## 5. Kurulum ve çalıştırma (yerel geliştirme)

### Backend — Cloudflare Worker (önerilen, prod'da kullanılan)

```bash
cd worker
npm install
cp .dev.vars.example .dev.vars    # SECRET_KEY'i istediğiniz gibi değiştirin
npm run db:init:local              # yerel D1 taklidine şemayı uygular
npm run dev                        # http://127.0.0.1:8787'de çalışır
```

İş mantığını (RNG doğruluğu, rate limiting, leaderboard, cookie imzalama)
gerçek bir Cloudflare hesabı olmadan doğrulayan test paketi:

```bash
node test/run.mjs
```

### Backend — FastAPI (alternatif, kendi sunucunuzda barındırmak isterseniz)

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

`frontend/app.js`'teki `API_BASE`, `frontend/config.js`'in doldurduğu
`window.MONKEY_API_BASE`'den okunur (prod'da GitHub Actions bunu Worker'ın
gerçek URL'siyle otomatik doldurur, bkz. DEPLOY.md). Yerelde çalıştırmak
için `frontend/config.js`'i elle düzenleyin:

```js
window.MONKEY_API_BASE = "http://127.0.0.1:8787"; // Worker: npm run dev
// ya da: "http://localhost:8000" // FastAPI kullanıyorsanız
```

Ardından statik bir sunucuyla açın (doğrudan `file://` ile açmak
cookie/CORS davranışını bozabilir):

```bash
cd frontend
python3 -m http.server 5500
```

Tarayıcıda `http://localhost:5500` adresine gidin. Backend'deki
`FRONTEND_ORIGINS` değişkeninin bu adresi içerdiğinden emin olun
(hem `worker/wrangler.toml` hem `backend/.env.example`'da varsayılan
zaten `localhost:5500` içeriyor).

## 6. Yayına alma

**Varsayılan ve önerilen yol: $0 maliyet, sadece GitHub.** Adım adım
**[DEPLOY.md](DEPLOY.md)**'ye bakın: frontend GitHub Pages'e, backend
Cloudflare Workers + D1'e gidiyor, `main`'e her push'ta ikisi de GitHub
Actions ile otomatik güncelleniyor. Domain almanıza, sunucu kiralamanıza
ya da kredi kartı bilgisi girmenize gerek yok.

Kendi sunucunuzda (VM) barındırmayı tercih ederseniz — örn. özel bir
domain'e bağlamak istiyorsanız — `backend/`, `Dockerfile`,
`docker-compose.yml` ve `deploy/nginx.conf.example` hâlâ repoda; bu yol
artık DEPLOY.md'nin ana konusu değil ama dosyalar çalışır durumda kaldı.

## 7. Dosya yapısı

```
monkey-typewriter/
├── .github/
│   └── workflows/
│       ├── pages.yml          # main'e push'ta frontend'i GitHub Pages'e yayınlar
│       └── deploy-worker.yml  # main'e push'ta backend'i Cloudflare Worker'a yayınlar
├── worker/                    # BİRİNCİL backend — Cloudflare Worker + D1
│   ├── src/index.js           # Tüm API — RNG, session, rate limiting, leaderboard
│   ├── schema.sql             # D1 tabloları (game_session, leaderboard_entry, ip_hit)
│   ├── wrangler.toml          # Worker + D1 binding config
│   ├── package.json
│   ├── .dev.vars.example
│   └── test/                  # Cloudflare hesabı gerektirmeyen mantık testleri
├── backend/                   # Alternatif — FastAPI (kendi sunucunuzda barındırmak isterseniz)
│   ├── main.py
│   ├── requirements.txt
│   └── .env.example
├── frontend/
│   ├── index.html             # Üstte "yazdıklarımız" şeridi, altta Hamlet referans metni
│   ├── style.css              # Retro daktilo teması
│   ├── config.js              # Deploy anında Worker URL'siyle dolduruluyor (bkz. pages.yml)
│   └── app.js                 # Sadece görüntüleme + istek tetikleme
├── deploy/
│   └── nginx.conf.example     # Sadece FastAPI/VM yolunu kullananlar için
├── .gitignore
├── Dockerfile                 # Sadece FastAPI/VM yolunu kullananlar için
├── docker-compose.yml         # Sadece FastAPI/VM yolunu kullananlar için
├── DEPLOY.md                  # $0 maliyetle GitHub Pages + Cloudflare Workers'a yayınlama rehberi
└── README.md
```
