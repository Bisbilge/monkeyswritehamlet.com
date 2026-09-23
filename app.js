// Sonsuz Maymun Teoremi — tek dosyalık, tamamen istemci-taraflı sürüm.
//
// Bu sürümde sunucu YOK: sadece GitHub Pages üzerinden servis edilen
// statik dosyalar var. Bu, önceki backend'li (Cloudflare Worker / FastAPI)
// sürümdeki "sunucu-taraflı, sahtekarlığa kapalı RNG ve skor" garantisinin
// artık geçerli olmadığı anlamına gelir — bir tarayıcı konsolu açıp bu
// sayfadaki state'i istediği gibi değiştirebilecek bilgisi olan biri,
// rekorunu da değiştirebilir. Bu yüzden:
//   - Paylaşılan/karşılaştırmalı bir liderlik tablosu YOK (böyle bir şeyin
//     bir backend olmadan anlamlı ya da güvenilir olması mümkün değil).
//   - "Rekor" sadece bu tarayıcıda, localStorage'da tutulan KİŞİSEL bir
//     istatistik; başka bir cihazda ya da gizli sekmede sıfırdan başlar.
// Buna karşılık, rastgele karakter üretimi yine de kriptografik olarak
// güvenli bir üreteçle (crypto.getRandomValues, reddetme örneklemesiyle
// bias'sız) yapılıyor — yani oyunun "dürüst zar" kısmı hâlâ doğru.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz "; // 27 karakter (26 harf + boşluk)
const BEST_STREAK_KEY = "monkeyBestStreak";
const CLIENT_THROTTLE_MS = 90; // aynı tuşu basılı tutarak spam atmayı caydırmak için

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

// Kriptografik olarak güvenli, bias'sız karakter seçimi: basit
// `Math.random() * n | 0` yerine crypto.getRandomValues + reddetme
// örneklemesi kullanıyoruz (n=27, 2^32'yi tam bölmediği için modulo bias
// oluşur — bunu 2^32'nin 27'ye tam bölünen en büyük katının üstünde kalan
// değerleri reddederek önlüyoruz).
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

const els = {
  streak: document.getElementById("streak-value"),
  best: document.getElementById("best-value"),
  rolls: document.getElementById("rolls-value"),
  target: document.getElementById("target-text"),
  typedFeed: document.getElementById("typed-feed"),
  rolledChar: document.getElementById("rolled-char"),
  rollButton: document.getElementById("roll-button"),
  statusLine: document.getElementById("status-line"),
};

const TYPED_LOG_MAX = 3000; // bellek/DOM şişmesin diye üst şeritteki dökümü sınırlıyoruz

function loadBestStreak() {
  try {
    const raw = localStorage.getItem(BEST_STREAK_KEY);
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (e) {
    return 0; // localStorage kapalıysa (gizli sekme vb.) sessizce 0'dan başla
  }
}

function saveBestStreak(n) {
  try {
    localStorage.setItem(BEST_STREAK_KEY, String(n));
  } catch (e) {
    /* localStorage yoksa rekor sadece bu oturumda hatırlanır */
  }
}

const state = {
  currentIndex: 0,
  currentStreak: 0,
  bestStreak: loadBestStreak(),
  totalRolls: 0,
  lastRollAt: 0,
  typedLog: [], // [{char, correct}, ...] — o ana kadar üretilen HER karakter, sırayla
};

function setStatus(text) {
  els.statusLine.textContent = text;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderTargetText() {
  const text = TARGET_TEXT;
  const parts = [];
  const matched = escapeHtml(text.slice(0, state.currentIndex));
  const current = text[state.currentIndex] === " " ? "&nbsp;" : escapeHtml(text[state.currentIndex] || "");
  const pending = escapeHtml(text.slice(state.currentIndex + 1));

  if (matched) parts.push(`<span class="matched">${matched}</span>`);
  if (current) parts.push(`<span class="current">${current}</span>`);
  if (pending) parts.push(`<span class="pending">${pending}</span>`);

  els.target.innerHTML = parts.join("");

  const currentEl = els.target.querySelector(".current");
  if (currentEl) {
    currentEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function appendTypedChar(char, correct) {
  state.typedLog.push({ char, correct });
  if (state.typedLog.length > TYPED_LOG_MAX) {
    state.typedLog.splice(0, state.typedLog.length - TYPED_LOG_MAX);
  }
  renderTypedFeed();
}

function renderTypedFeed() {
  const html = state.typedLog
    .map((entry) => {
      const display = entry.char === " " ? "␣" : escapeHtml(entry.char);
      const cls = entry.correct ? "ok" : "bad";
      return `<span class="${cls}">${display}</span>`;
    })
    .join("");
  els.typedFeed.innerHTML = html + '<span class="cursor-blink">&nbsp;</span>';
  els.typedFeed.scrollTop = els.typedFeed.scrollHeight;
}

function renderStats() {
  els.streak.textContent = state.currentStreak;
  els.best.textContent = state.bestStreak;
  els.rolls.textContent = state.totalRolls;
}

function flashRolledChar(char, correct) {
  const display = char === " " ? "␣" : char;
  els.rolledChar.textContent = display;
  els.rolledChar.classList.remove("correct", "wrong", "stamp");
  void els.rolledChar.offsetWidth; // reflow ile animasyonu yeniden tetikle
  els.rolledChar.classList.add(correct ? "correct" : "wrong", "stamp");
}

function doRoll() {
  const now = performance.now();
  if (now - state.lastRollAt < CLIENT_THROTTLE_MS) return;
  state.lastRollAt = now;

  const previousStreak = state.currentStreak;
  const char = randomChar();
  const targetChar = TARGET_TEXT[state.currentIndex];
  const correct = char === targetChar;

  let completed = false;

  if (correct) {
    state.currentIndex += 1;
    state.currentStreak += 1;
    if (state.currentStreak > state.bestStreak) {
      state.bestStreak = state.currentStreak;
      saveBestStreak(state.bestStreak);
    }
    if (state.currentIndex >= TARGET_LENGTH) {
      completed = true;
      state.currentIndex = 0; // bir tur bitince baştan başla
    }
  } else {
    state.currentIndex = 0;
    state.currentStreak = 0;
  }

  state.totalRolls += 1;

  flashRolledChar(char, correct);
  appendTypedChar(char, correct);
  renderTargetText();
  renderStats();

  if (completed) {
    setStatus("İNANILMAZ! Bütün tiradı hatasız tamamladın!");
  } else if (!correct && previousStreak > 0) {
    setStatus(`Seri bozuldu (${previousStreak} karakterdeydin). Baştan başlıyoruz.`);
  } else if (correct) {
    setStatus("Devam et…");
  }
}

// --- Olay dinleyicileri -----------------------------------------------

els.rollButton.addEventListener("click", doRoll);

window.addEventListener("keydown", (e) => {
  if (e.repeat) return; // tuşu basılı tutarak spam atmayı caydır
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  doRoll();
});

// --- Başlat --------------------------------------------------------------

renderTargetText();
renderTypedFeed();
renderStats();
