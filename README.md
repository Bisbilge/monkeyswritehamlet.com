# Sonsuz Maymun Teoremi

Hamlet'in "To be, or not to be" tiradını, tek tuşla üretilen rastgele
karakterlerle baştan sona hatasız tutturmaya çalıştığın minimalist bir
oyun. Konseptin özü: her tuşa basış bağımsız bir "maymun zarı" — 27
karakterlik alfabeden (a-z + boşluk) rastgele bir karakter üretilir ve
hedef metindeki bir sonraki karakterle karşılaştırılır.

## Nasıl çalışır

Bu proje **tamamen tek bir statik siteden** ibaret: `index.html`,
`style.css`, `app.js`. Hiçbir sunucu, veritabanı veya üçüncü parti servis
yok — sadece [GitHub Pages](https://pages.github.com/) üzerinden servis
ediliyor. `app.js`:

- Rastgele karakteri `crypto.getRandomValues()` ile, reddetme
  örneklemesiyle bias'sız şekilde üretir (basit `Math.random()`'dan
  farklı olarak tarayıcının kriptografik RNG'sini kullanır).
- Üretilen karakteri hedef metindeki bir sonraki karakterle karşılaştırır,
  seriyi (streak) ilerletir ya da sıfırlar.
- Rekoru (`bestStreak`) tarayıcının `localStorage`'ında saklar.
- İlerlemeyi bir çubukla (tiradın yüzde kaçı tutturuldu) ve seri/rekor
  değiştiğinde kısa bir animasyonla gösterir.

**Dürüst olmak gerekirse:** bu, sunucu tarafında doğrulanan bir sistem
değil. Tamamen istemci tarafında çalıştığı için, tarayıcı konsolunu açıp
JavaScript state'ini değiştirebilecek biri kendi rekorunu da
değiştirebilir. Bu yüzden bilerek paylaşılan/karşılaştırmalı bir liderlik
tablosu yok — böyle bir şeyin bir backend olmadan güvenilir olması mümkün
değil. Rekor sadece kişisel bir istatistik, başka bir cihazda veya gizli
sekmede sıfırdan başlar. Oyunun "dürüst zar" kısmı (rastgele karakter
üretimi) yine de kriptografik olarak sağlam.

## Yayına alma

Site şu anda yayında: **https://bisbilge.github.io/monkeyswritehamlet.com/**

Aynısını başka bir hesapta yapmak isteyen biri için tek adım: repo →
**Settings → Pages** → "Build and deployment" → **Source: Deploy from a
branch** → Branch: **main**, klasör: **/ (root)** → Save. (GitHub Pages,
ücretsiz katmanda yalnızca **public** repolarda çalışıyor.)

Başka hiçbir kurulum, hesap ya da ücret gerekmiyor. `main`'e her push,
GitHub Pages'i otomatik günceller — ayrıca bir CI/CD workflow'una da
gerek yok çünkü build adımı yok.

## Yerelde çalıştırma

```bash
python3 -m http.server 5500
```

Tarayıcıda `http://localhost:5500` adresine gidin. (`index.html`'i
doğrudan `file://` ile açmak da çalışır, ama `localStorage` bazı
tarayıcılarda `file://` origin'inde kısıtlı davranabilir.)

## Dosya yapısı

```
monkeyswritehamlet.com/
├── index.html
├── style.css
├── app.js
└── README.md
```
