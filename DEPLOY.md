# Yayına alma: tamamen ücretsiz, sadece GitHub

Bu proje artık **hiçbir sunucu kiralamadan, domain almadan** yayınlanacak
şekilde kurulu:

- **Frontend** → [GitHub Pages](https://pages.github.com/) (ücretsiz, sınırsız süre, `https://<kullanıcı-adınız>.github.io/monkeyswritehamlet.com/` adresinde).
- **Backend** (anti-cheat mantığının yaşadığı yer) → [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) (ücretsiz katman, kredi kartı gerektirmez, `https://monkey-api.<sizin-subdomain>.workers.dev` adresinde).
- **CI/CD** → GitHub Actions, `main`'e her push'ta ikisini de otomatik günceller.

Toplam maliyet: **$0**. Domain almadığınız için özel bir alan adınız
olmayacak — oyun `github.io` ve `workers.dev` alt alan adlarında yaşayacak.
(İleride bir domain almak isterseniz DEPLOY.md'nin sonundaki "Daha sonra
özel domain eklemek isterseniz" bölümüne bakın — mevcut mimariye kolayca
eklenebilir.)

## 0. Genel bakış — neden bu iki servis?

| Katman | Servis | Neden ücretsiz/kalıcı |
|---|---|---|
| Statik dosyalar (HTML/CSS/JS) | GitHub Pages | Zaten kullandığınız GitHub hesabıyla geliyor, süresiz ücretsiz, uyku modu yok. |
| Sunucu mantığı (RNG, session, rate limit, leaderboard) | Cloudflare Workers + D1 | Workers'ın günlük ücretsiz kotası (100.000 istek/gün) bu boyuttaki bir hobi projesi için fazlasıyla yeterli; D1 (SQLite tabanlı) 5GB'a kadar ücretsiz. Render/Fly.io gibi seçeneklerin aksine uykuya dalmıyor, kredi kartı istemiyor. |

Backend'i Python/FastAPI'den JavaScript'e taşımamızın tek sebebi bu: GitHub
Pages sadece statik dosya sunar, Python çalıştıramaz; "tamamen ücretsiz +
GitHub üzerinden" isteğini karşılamak için sunucu mantığını, aynı güvenlik
garantileriyle (kriptografik RNG, imzalı session, sunucu-taraflı skor) bir
Cloudflare Worker'a taşıdık. `worker/src/index.js` dosyası eski
`backend/main.py`'nin birebir JavaScript karşılığıdır — karşılaştırmak
isterseniz ikisini yan yana okuyabilirsiniz. (`backend/` klasörü, ileride
kendi sunucunuzda barındırmak isterseniz diye referans olarak repoda kaldı;
aşağıdaki adımların hiçbiri ona ihtiyaç duymuyor.)

## 1. Cloudflare hesabı ve D1 veritabanı (bir kere yapılır)

1. [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) üzerinden
   ücretsiz bir hesap açın (kredi kartı istemez).
2. Bilgisayarınızda (bu repo'yu klonladığınız yerde):
   ```bash
   cd worker
   npm install       # wrangler'ı indirir
   npx wrangler login   # tarayıcıda Cloudflare hesabınızla giriş yaptırır
   ```
3. D1 veritabanını oluşturun:
   ```bash
   npx wrangler d1 create monkey-db
   ```
   Çıktıda şöyle bir satır göreceksiniz:
   ```
   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
   ```
   Bu `database_id`'yi kopyalayıp `worker/wrangler.toml` dosyasındaki
   `REPLACE_WITH_YOUR_D1_DATABASE_ID` yerine yapıştırın.
4. Şemayı (tabloları) bir kere uygulayın:
   ```bash
   npx wrangler d1 execute monkey-db --remote --file=./schema.sql
   ```
5. `wrangler.toml`'daki `FRONTEND_ORIGINS` değişkenini kendi GitHub
   kullanıcı adınıza göre kontrol edin — varsayılan
   `https://bisbilge.github.io` şeklinde; farklıysa güncelleyin (sonunda
   `/` OLMAMALI, sadece origin).
6. Cloudflare hesabınızın **Account ID**'sini not edin: Cloudflare
   dashboard → sağ alt köşe / Workers & Pages sayfasında görünür.
7. Bir **API token** oluşturun: dashboard → sağ üst profil ikonu → **My
   Profile → API Tokens → Create Token** → "Edit Cloudflare Workers"
   şablonunu kullanın. Token'ın izinlerine **D1: Edit**'i de eklediğinizden
   emin olun (şablon bazen sadece Workers Scripts içerir). Token'ı kopyalayın
   — bir daha gösterilmeyecek.

Bu adımların tamamı **bir kereliktir**; bundan sonra kod her değiştiğinde
GitHub Actions otomatik deploy edecek.

## 2. GitHub repo secrets/variables

Repo → **Settings → Secrets and variables → Actions**'a gidin.

**Secrets** sekmesinde şunları ekleyin:

| İsim | Değer |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Adım 1.7'de oluşturduğunuz token |
| `CLOUDFLARE_ACCOUNT_ID` | Adım 1.6'da not ettiğiniz Account ID |
| `MONKEY_SECRET_KEY` | `python3 -c "import secrets; print(secrets.token_hex(32))"` ile üretilen rastgele bir dize — session cookie'lerini imzalamak için kullanılır, asla paylaşmayın |

**Variables** sekmesinde (bunlar sır değil, sadece bir yapılandırma):

| İsim | Değer |
|---|---|
| `WORKER_URL` | Aşağıdaki adım 3'ten sonra öğreneceğiniz Worker URL'si — şimdilik BOŞ bırakabilirsiniz, adım 4'te ekleyeceğiz. |

## 3. İlk deploy: backend (Worker)

Secrets eklendikten sonra `worker/` klasöründe bir değişiklik push'lamanız
(ya da Actions sekmesinden elle tetiklemeniz) yeterli:

- GitHub'da repo → **Actions** sekmesi → **Deploy Backend (Cloudflare
  Worker)** workflow'unu seçip **Run workflow** ile elle çalıştırın (kod
  zaten repoda, `worker/` klasöründe bir push beklemenize gerek yok).
- Workflow bitince Cloudflare dashboard → **Workers & Pages** →
  `monkey-api`'ye tıklayın; oradaki URL'yi kopyalayın (şuna benzer:
  `https://monkey-api.SIZIN-SUBDOMAIN.workers.dev`).

## 4. Worker URL'sini frontend'e bağlama + GitHub Pages'i aktifleştirme

1. Repo → **Settings → Pages** → "Build and deployment" → **Source**:
   **GitHub Actions** seçin (bir kereliktir).
2. Repo → **Settings → Secrets and variables → Actions → Variables**'a
   dönüp `WORKER_URL` değişkenini adım 3'te kopyaladığınız URL ile
   güncelleyin (ya da yeni oluşturun).
3. Actions sekmesinden **Deploy Frontend (GitHub Pages)** workflow'unu elle
   çalıştırın (`Run workflow`) — bu sefer `config.js` içine gerçek Worker
   URL'sini gömecek.
4. Birkaç saniye sonra siteniz şurada olacak:
   `https://<kullanıcı-adınız>.github.io/monkeyswritehamlet.com/`
   (repo → Settings → Pages sayfasında da tam URL yazıyor.)

Bundan sonra `main`'e her push'ta:
- `frontend/` altında bir değişiklik varsa → Pages otomatik güncellenir.
- `worker/` altında bir değişiklik varsa → Worker otomatik güncellenir.

## 5. Doğrulama

- `https://<kullanıcı-adınız>.github.io/monkeyswritehamlet.com/` açılmalı,
  "TUŞA BAS" düğmesi çalışmalı, üst şeritte ürettiğiniz karakterler,
  altta Hamlet metninin ilerlemesi görünmeli.
- Tarayıcı DevTools → Network sekmesinde `/api/session` ve `/api/roll`
  isteklerinin `monkey-api...workers.dev` adresine gittiğini ve
  200/429 dışında bir hata almadığını kontrol edin.
- Bir seri yapıp liderlik tablosuna skor gönderin, sayfayı yenileyin,
  skorun kalıcı olduğunu (D1'de saklandığını) doğrulayın.
- `https://monkey-api.SIZIN-SUBDOMAIN.workers.dev/api/health` adresine
  gidip `{"status":"ok",...}` gördüğünüzü doğrulayın.

## 6. Yerelde geliştirme (opsiyonel)

```bash
# Backend
cd worker
cp .dev.vars.example .dev.vars   # SECRET_KEY'i istediğiniz gibi değiştirin
npm run db:init:local             # yerel D1 taklidine şemayı uygular
npm run dev                       # http://127.0.0.1:8787'de çalışır

# Frontend (ayrı bir terminalde)
cd frontend
# config.js'i geçici olarak yerel Worker'a işaret ettirin:
#   window.MONKEY_API_BASE = "http://127.0.0.1:8787";
python3 -m http.server 5500
```

`worker/test/run.mjs`, gerçek bir Cloudflare hesabına ihtiyaç duymadan
anti-cheat mantığını (RNG doğruluğu, rate limiting, leaderboard sıralaması,
cookie imzalama) doğrulayan bağımsız bir test paketidir:
```bash
cd worker && node test/run.mjs
```

## Daha sonra özel domain eklemek isterseniz

Bu mimariyi bozmadan bir domain (örn. Squarespace'ten aldığınız
`monkeyswritehamlet.com`) ekleyebilirsiniz:

- **Frontend için**: repo → Settings → Pages → "Custom domain" alanına
  domain'inizi yazın, DNS'te GitHub Pages'in istediği CNAME/A kayıtlarını
  ekleyin ([resmi rehber](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)).
- **Backend için**: Cloudflare, Workers'a özel domain bağlamayı da
  ücretsiz destekler ("Custom Domains" — domain'in DNS'inin Cloudflare
  üzerinden yönetiliyor olması gerekir).

Bu durumda tek maliyet yine sadece domain ücreti olur (~$12-20/yıl),
sunucu tarafı hâlâ $0 kalır.
