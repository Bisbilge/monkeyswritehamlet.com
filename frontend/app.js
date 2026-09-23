// Sonsuz Maymun Teoremi — Frontend
//
// Bu dosya SADECE görüntüleme ve istek tetikleme yapar. Doğruluk
// kontrolü, ilerleme, seri (streak) ve skor TAMAMEN backend'de
// hesaplanır; burada tutulan `state` nesnesi yalnızca sunucudan
// gelen son yanıtın bir yansımasıdır — oyunun "gerçek" kaynağı değil.

// Boş string = "aynı origin" — prod'da frontend'i backend aynı sunucudan
// servis ettiği için (bkz. main.py'deki StaticFiles mount) varsayılan budur.
// Frontend'i ayrı bir statik sunucudan (örn. `python -m http.server 5500`)
// çalıştırıyorsanız index.html'de app.js'ten ÖNCE şunu ekleyin:
//   <script>window.MONKEY_API_BASE = "http://localhost:8000";</script>
const API_BASE = window.MONKEY_API_BASE || "";
const CLIENT_THROTTLE_MS = 90; // backend'deki MIN_ROLL_INTERVAL_MS'den biraz gevşek

const els = {
  streak: document.getElementById("streak-value"),
  best: document.getElementById("best-value"),
  rolls: document.getElementById("rolls-value"),
  target: document.getElementById("target-text"),
  targetFeed: document.getElementById("target-feed"),
  typedFeed: document.getElementById("typed-feed"),
  rolledChar: document.getElementById("rolled-char"),
  rollButton: document.getElementById("roll-button"),
  submitScoreButton: document.getElementById("submit-score-button"),
  leaderboardList: document.getElementById("leaderboard-list"),
  statusLine: document.getElementById("status-line"),
  modalBackdrop: document.getElementById("modal-backdrop"),
  modalScoreText: document.getElementById("modal-score-text"),
  nicknameForm: document.getElementById("nickname-form"),
  nicknameInput: document.getElementById("nickname-input"),
  modalCancel: document.getElementById("modal-cancel"),
  modalError: document.getElementById("modal-error"),
};

const TYPED_LOG_MAX = 3000; // bellek/DOM şişmesin diye üst şeritteki dökümü sınırlıyoruz

const state = {
  targetText: "",
  currentIndex: 0,
  currentStreak: 0,
  bestStreak: 0,
  totalRollsThisPage: 0,
  lastRollAt: 0,
  busy: false,
  typedLog: [], // [{char, correct}, ...] — o ana kadar üretilen HER karakter, sırayla
};

function setStatus(text) {
  els.statusLine.textContent = text;
}

async function api(path, options = {}) {
  const res = await fetch(API_BASE + path, {
    method: "GET",
    credentials: "include", // imzalı session cookie'sinin gidip gelmesi için şart
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = new Error("Request failed: " + res.status);
    err.status = res.status;
    try {
      err.body = await res.json();
    } catch (_) {
      /* noop */
    }
    throw err;
  }
  return res.json();
}

function renderTargetText() {
  const text = state.targetText;
  const parts = [];
  const matched = escapeHtml(text.slice(0, state.currentIndex));
  const current = text[state.currentIndex] === " " ? "&nbsp;" : escapeHtml(text[state.currentIndex] || "");
  const pending = escapeHtml(text.slice(state.currentIndex + 1));

  if (matched) parts.push(`<span class="matched">${matched}</span>`);
  if (current) parts.push(`<span class="current">${current}</span>`);
  if (pending) parts.push(`<span class="pending">${pending}</span>`);

  els.target.innerHTML = parts.join("");

  // Hedef metin baştan sona her zaman görünür (§ "hamleti en baştan yaz");
  // sadece imlecin (current) her zaman görünür alanda kalmasını sağlıyoruz.
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

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderStats() {
  els.streak.textContent = state.currentStreak;
  els.best.textContent = state.bestStreak;
  els.rolls.textContent = state.totalRollsThisPage;
}

function renderLeaderboard(entries) {
  if (!entries || entries.length === 0) {
    els.leaderboardList.innerHTML = '<li class="leaderboard-empty">Henüz kimse liderlik tablosuna giremedi.</li>';
    return;
  }
  els.leaderboardList.innerHTML = entries
    .map(
      (e) =>
        `<li><span class="leaderboard-name">${escapeHtml(e.nickname)}</span><span class="leaderboard-score">${e.score}</span></li>`
    )
    .join("");
}

async function refreshLeaderboard() {
  try {
    const entries = await api("/api/leaderboard");
    renderLeaderboard(entries);
  } catch (e) {
    // Liderlik tablosu yüklenemezse oyunu bloklamıyoruz, sessizce geçiyoruz.
  }
}

async function refreshEligibility() {
  try {
    const info = await api("/api/leaderboard/eligible");
    els.submitScoreButton.disabled = !info.eligible;
    return info;
  } catch (e) {
    return { eligible: false };
  }
}

async function initSession() {
  setStatus("Bağlanıyor…");
  try {
    const data = await api("/api/session", { method: "POST" });
    state.targetText = data.target_text;
    state.currentIndex = data.current_index;
    state.currentStreak = data.current_streak;
    state.bestStreak = data.best_streak;
    renderTargetText();
    renderTypedFeed();
    renderStats();
    setStatus("Hazır. Tuşa bas.");
    await Promise.all([refreshLeaderboard(), refreshEligibility()]);
  } catch (e) {
    setStatus("Sunucuya bağlanılamadı. Backend çalışıyor mu? (" + API_BASE + ")");
  }
}

function flashRolledChar(char, correct) {
  const display = char === " " ? "␣" : char;
  els.rolledChar.textContent = display;
  els.rolledChar.classList.remove("correct", "wrong", "stamp");
  // reflow ile animasyonu yeniden tetikle
  void els.rolledChar.offsetWidth;
  els.rolledChar.classList.add(correct ? "correct" : "wrong", "stamp");
}

async function doRoll() {
  const now = performance.now();
  if (state.busy) return;
  if (now - state.lastRollAt < CLIENT_THROTTLE_MS) return;
  state.lastRollAt = now;
  state.busy = true;
  els.rollButton.disabled = true;

  const previousStreak = state.currentStreak;

  try {
    const data = await api("/api/roll", { method: "POST" });

    flashRolledChar(data.char, data.correct);
    appendTypedChar(data.char, data.correct);

    state.currentIndex = data.current_index;
    state.currentStreak = data.current_streak;
    state.bestStreak = data.best_streak;
    state.totalRollsThisPage += 1;

    renderTargetText();
    renderStats();

    if (data.completed) {
      setStatus("İNANILMAZ! Bütün tiradı hatasız tamamladın!");
    } else if (!data.correct && previousStreak > 0) {
      setStatus(`Seri bozuldu (${previousStreak} karakterdeydin). Baştan başlıyoruz.`);
    } else if (data.correct) {
      setStatus("Devam et…");
    }

    if (!data.correct || data.completed) {
      if (previousStreak > 0 || data.completed) {
        const info = await refreshEligibility();
        if (info.eligible) {
          openNicknameModal();
        }
      }
    }
  } catch (e) {
    if (e.status === 429) {
      setStatus("Biraz yavaşla — sunucu çok hızlı istekleri kabul etmiyor.");
    } else {
      setStatus("Bir hata oluştu, tekrar deneniyor…");
    }
  } finally {
    state.busy = false;
    els.rollButton.disabled = false;
  }
}

function openNicknameModal() {
  els.modalScoreText.textContent = `Serin: ${state.bestStreak} karakter. Liderlik tablosuna girmeye hak kazandın.`;
  els.modalError.textContent = "";
  els.nicknameInput.value = "";
  els.modalBackdrop.classList.add("open");
  setTimeout(() => els.nicknameInput.focus(), 50);
}

function closeNicknameModal() {
  els.modalBackdrop.classList.remove("open");
}

async function submitNickname(nickname) {
  els.modalError.textContent = "";
  try {
    await api("/api/leaderboard/submit", {
      method: "POST",
      body: JSON.stringify({ nickname }),
    });
    closeNicknameModal();
    setStatus("Skorun liderlik tablosuna eklendi.");
    await Promise.all([refreshLeaderboard(), refreshEligibility()]);
  } catch (e) {
    const detail =
      (e.body && (typeof e.body.detail === "string" ? e.body.detail : e.body.detail?.[0]?.msg)) ||
      "Gönderilemedi, tekrar dene.";
    els.modalError.textContent = detail;
  }
}

// --- Olay dinleyicileri -----------------------------------------------

els.rollButton.addEventListener("click", doRoll);

window.addEventListener("keydown", (e) => {
  if (els.modalBackdrop.classList.contains("open")) return;
  if (e.repeat) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  doRoll();
});

els.submitScoreButton.addEventListener("click", async () => {
  const info = await refreshEligibility();
  if (info.eligible) {
    openNicknameModal();
  } else {
    setStatus("Liderlik tablosuna girecek bir skorun yok.");
  }
});

els.modalCancel.addEventListener("click", closeNicknameModal);
els.modalBackdrop.addEventListener("click", (e) => {
  if (e.target === els.modalBackdrop) closeNicknameModal();
});

els.nicknameForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const nickname = els.nicknameInput.value.trim();
  if (!nickname) return;
  submitNickname(nickname);
});

// --- Başlat --------------------------------------------------------------

initSession();
setInterval(refreshLeaderboard, 15000);
