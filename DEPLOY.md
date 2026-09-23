# Yayına alma: monkeyswritehamlet.com

Kısa özet: Kodu **GitHub'da** tutuyoruz; **Squarespace'ten sadece
domain'i** alıyoruz (Squarespace'in kendisi Python/FastAPI gibi özel
sunucu kodu çalıştıramaz — orası bir site oluşturucu, hosting değil);
uygulamayı **Oracle Cloud'un Always Free VM'inde** barındırıyoruz (bu
gerçekten süresiz ücretsiz ve SQLite dosyanız için kalıcı disk
veriyor); ve `main`'e her push'ta VM'i otomatik güncelleyen bir
**GitHub Actions** workflow'u kuruyoruz.

## 0. Neden Oracle Cloud Free Tier?

| Seçenek | Aylık maliyet | Sorun |
|---|---|---|
| **Oracle Cloud Always Free** | **$0, süresiz** | Kurulumu biraz VPS bilgisi ister (aşağıda adım adım var) |
| Render free web service | $0 | 15 dk hareketsizlikte uyur, tekrar açılması ~1 dk sürer; disk kalıcı değil, free Postgres 30 günde siliniyor — leaderboard'un periyodik sıfırlanma riski var |
| Fly.io | ~$2-4/ay | Artık gerçek bir free tier yok, kredi kartı zorunlu |
| Railway | İlk ay $5 kredi, sonra $1/ay kredi | Pratikte ücretsiz değil |
| PythonAnywhere | $0 (ama custom domain yok) | Kendi domain'inizi bağlamak için ücretli plana geçmeniz gerekiyor |

Oracle hesabı açarken kredi kartı istiyor (kimlik doğrulama için) ama
Always Free kaynaklarını kullandığınız sürece hiç ücret kesilmiyor.
Tek dezavantajı: bazı bölgelerde ücretsiz VM stoğu anlık dolabiliyor,
birkaç kez denemeniz gerekebilir.

## 1. GitHub reposu

1. GitHub'da boş bir repo açın (örn. `monkeyswritehamlet`), **private**
   tutmanızı öneririm (backend kodu public olsa sorun değil ama
   alışkanlık olarak SECRET_KEY gibi şeylerin hiç commit'lenmemesi
   gerektiğini `.gitignore` zaten sağlıyor).
2. Bu klasörü push'layın:
   ```bash
   cd monkey-typewriter
   git init
   git add .
   git commit -m "İlk sürüm"
   git branch -M main
   git remote add origin git@github.com:<kullanici-adiniz>/monkeyswritehamlet.git
   git push -u origin main
   ```
   `.gitignore` zaten `.env`, `monkey.db` ve `data/` klasörünü dışarıda
   bırakıyor — bunları asla commit'lemeyin.

## 2. Domain: Squarespace Domains

1. [domains.squarespace.com](https://domains.squarespace.com) üzerinden
   `monkeyswritehamlet.com`'u satın al — bunun için bir Squarespace
   web sitesi planına ihtiyacınız yok, Squarespace domain'i tek
   başına da satıyor.
2. Satın aldıktan sonra Squarespace'in domain yönetim panelinden
   **DNS Settings**'e girin. Oracle VM'inizin IP'sini aldıktan sonra
   (adım 3) şu kaydı ekleyeceksiniz:
   - Tip: `A`, Host: `@`, Değer: `<VM'in public IP'si>`
   - Tip: `A`, Host: `www`, Değer: `<VM'in public IP'si>`
   (Squarespace'in kendi varsayılan "parking" kayıtlarını silmeniz gerekebilir.)

## 3. Oracle Cloud Always Free VM

1. [oracle.com/cloud/free](https://www.oracle.com/cloud/free/) üzerinden
   hesap açın.
2. **Instances → Create Instance**: Ubuntu 24.04, shape olarak
   **VM.Standard.A1.Flex** (ARM, Always Free) seçin — 1 OCPU / 6GB RAM
   bu oyun için fazlasıyla yeterli (limit 4 OCPU/24GB'a kadar
   ücretsiz, ihtiyacınız yok).
3. SSH anahtarınızı ekleyin, instance'ı oluşturun, **public IP**'yi not edin.
4. **ÖNEMLİ — Oracle'a özgü tuzak:** Port 80/443 iki katmanda da açık
   olmalı, yoksa siteye hiç erişilemez:
   - Oracle Console'da: **Networking → Virtual Cloud Networks →
     (VCN'iniz) → Security Lists** → ingress kuralı ekleyin: `0.0.0.0/0`,
     TCP, port 80 ve 443.
   - VM'in içinde (Ubuntu görüntüleri `iptables` ile gelir, varsayılan
     kurallar sadece SSH'a izin verir):
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```

## 4. Uygulamayı VM'e kurma (ilk kurulum, tek seferlik)

```bash
ssh ubuntu@<VM_IP>

# Docker + compose plugin
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker

# Repo'yu GitHub'dan klonlayın (private ise: git clone git@github.com:...
# için VM'e bir deploy key eklemeniz gerekir — repo Settings → Deploy keys)
git clone https://github.com/<kullanici-adiniz>/monkeyswritehamlet.git
cd monkeyswritehamlet

# .env dosyası oluşturun (bu dosya git'e girmez, VM'de elle oluşturuluyor)
echo "SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(32))')" > .env
echo "FRONTEND_ORIGINS=https://monkeyswritehamlet.com,https://www.monkeyswritehamlet.com" >> .env

mkdir -p data
docker compose up -d --build
curl http://127.0.0.1:8000/api/health   # {"status":"ok",...} görmelisiniz
```

## 5. nginx + HTTPS (Let's Encrypt)

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/monkeyswritehamlet.com
sudo ln -s /etc/nginx/sites-available/monkeyswritehamlet.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# DNS'in (adım 2) yayılmış olması lazım — "dig monkeyswritehamlet.com" ile kontrol edin
sudo certbot --nginx -d monkeyswritehamlet.com -d www.monkeyswritehamlet.com
```

certbot otomatik olarak nginx config'inizi 443/SSL için düzenler ve
yenileme cron/systemd-timer'ını kurar — elle bir şey yapmanıza gerek yok.

## 6. GitHub Actions ile otomatik deploy

Bundan sonra `main`'e her push attığınızda VM otomatik güncellensin
istiyorsanız (`.github/workflows/deploy.yml` depoda hazır):

1. VM'de, GitHub Actions'ın kullanacağı ayrı bir SSH anahtar çifti
   oluşturun ve public kısmını VM'in `~/.ssh/authorized_keys`'ine ekleyin:
   ```bash
   ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-actions-deploy"
   cat deploy_key.pub >> ~/.ssh/authorized_keys
   cat deploy_key   # bu private key'i bir sonraki adımda kullanacaksınız
   ```
2. GitHub'da repo → **Settings → Secrets and variables → Actions →
   New repository secret** ile şunları ekleyin:
   - `DEPLOY_HOST` → VM'in public IP'si (ya da domain'iniz)
   - `DEPLOY_USER` → `ubuntu`
   - `DEPLOY_SSH_KEY` → yukarıdaki `deploy_key` private key'in tüm içeriği
   - `DEPLOY_PATH` → `/home/ubuntu/monkeyswritehamlet` (repo'yu klonladığınız tam yol)
3. Bundan sonra `main`'e her push, workflow'u tetikler: VM'e SSH'lanır,
   `git pull` yapar, `docker compose up -d --build` çalıştırır. Actions
   sekmesinden ilerlemeyi izleyebilirsiniz.

Bu workflow sadece "kodu güncelle"yi otomatize ediyor — VM'in ilk
kurulumu (adım 4-5) hâlâ elle yapılan, tek seferlik bir iş.

## 7. Kontrol

- `https://monkeyswritehamlet.com` açılmalı, oyun oynanabilmeli.
- SQLite dosyası `./data/monkey.db`'de kalıcı — konteyner yeniden
  build olsa (ister elle `docker compose up -d --build`, ister
  GitHub Actions ile) da silinmez.
- `./data` klasörünü ara sıra VM dışına yedekleyin
  (`scp ubuntu@<VM_IP>:~/monkeyswritehamlet/data/monkey.db .`) —
  tek VM'lik bir kurulumda felaket kurtarma planınız bu.

## Toplam maliyet

**Sadece domain: yılda ~$12-20 (Squarespace .com fiyatı).** Sunucu
tarafı Oracle Always Free ile $0, GitHub reposu (public ya da private
fark etmez, Actions'ın ücretsiz kotası bu kadar az kullanım için
fazlasıyla yeterli) $0. Squarespace'in fiyatı zamanla değişebilir,
satın almadan hemen önce domains.squarespace.com'dan güncel rakamı
teyit edin.
