// ════════════════════════════════════════════════════════
//  NOVA — Cloud Music Platform  |  1.js
//  Stack: Firebase Auth + Firestore (без Storage)
//  Аудио хранится локально в IndexedDB
// ════════════════════════════════════════════════════════

import { initializeApp }         from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
         signOut, onAuthStateChanged, updateProfile }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, addDoc, getDocs,
         updateDoc, deleteDoc, query, where, increment, serverTimestamp, setDoc, arrayUnion, arrayRemove }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ─── ⚙️  FIREBASE CONFIG — ВСТАВЬ СВОЙ ────────────────
const firebaseConfig = {
  apiKey: "AIzaSyAJYAiDctSEQKvl8P0MuooE7EYWzhPZpG4",
  authDomain: "lunify-54953.firebaseapp.com",
  projectId: "lunify-54953",
  storageBucket: "lunify-54953.firebasestorage.app",
  messagingSenderId: "935328784664",
  appId: "1:935328784664:web:fc671f76a4c04a3a3afe6d",
  measurementId: "G-VYEHFRLXWZ"
};
// ───────────────────────────────────────────────────────

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// ─── INDEXEDDB (локальное хранение аудио файлов) ────────
const IDB_NAME    = "nova_audio";
const IDB_STORE   = "files";
const IDB_VERSION = 1;

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(IDB_STORE, { keyPath: "id" });
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

async function saveAudioIDB(id, file) {
  const db_ = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db_.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put({ id, file });
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

async function getAudioIDB(id) {
  const db_ = await openIDB();
  return new Promise((resolve, reject) => {
    const tx  = db_.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = e => resolve(e.target.result?.file || null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function deleteAudioIDB(id) {
  const db_ = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db_.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror    = e => reject(e.target.error);
  });
}

// ─── STATE ──────────────────────────────────────────────
let currentUser  = null;
let allTracks    = [];
let currentIndex = -1;
let isPlaying    = false;
let chartMode    = "plays";
let sortMode     = "date";
let searchQuery  = "";
let audioCtx     = null;
let analyser     = null;
let animFrameId  = null;
let currentBlobUrl = null;

const audio = document.getElementById("audio-el");

// ─── HELPERS ────────────────────────────────────────────
const $    = (id) => document.getElementById(id);
const el   = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
const fmt  = (n) => { const m = Math.floor(n / 60); const s = Math.floor(n % 60).toString().padStart(2, "0"); return `${m}:${s}`; };
const fmtBig = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
const rankClass = (i) => ["gold","silver","bronze"][i] || "other";
const esc  = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

function toast(msg, dur = 3000) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), dur);
}

function showPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  $(`page-${name}`).classList.add("active");
  document.querySelector(`[data-page="${name}"]`)?.classList.add("active");
  if (name === "profile") refreshProfile();
  if (name === "charts")  loadCharts();
  if (name === "library") renderLibrary();
}

// ─── AUTH ────────────────────────────────────────────────
document.querySelectorAll(".auth-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".auth-form").forEach(f => f.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

$("btn-login").addEventListener("click", async () => {
  const email = $("login-email").value.trim();
  const pass  = $("login-password").value;
  try {
    await signInWithEmailAndPassword(auth, email, pass);
  } catch (e) {
    $("auth-error").textContent = friendlyError(e.code);
  }
});

$("btn-register").addEventListener("click", async () => {
  const name  = $("reg-name").value.trim();
  const email = $("reg-email").value.trim();
  const pass  = $("reg-password").value;
  if (!name) { $("auth-error").textContent = "Введи имя"; return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db, "users", cred.user.uid), {
      displayName: name, email, createdAt: serverTimestamp()
    });
  } catch (e) {
    $("auth-error").textContent = friendlyError(e.code);
  }
});

$("btn-logout").addEventListener("click", () => signOut(auth));

function friendlyError(code) {
  const map = {
    "auth/email-already-in-use": "Email уже используется",
    "auth/invalid-email":        "Неверный формат email",
    "auth/weak-password":        "Пароль слишком короткий",
    "auth/user-not-found":       "Пользователь не найден",
    "auth/wrong-password":       "Неверный пароль",
    "auth/invalid-credential":   "Неверный email или пароль",
  };
  return map[code] || "Ошибка: " + code;
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    $("auth-screen").classList.add("hidden");
    $("app").classList.remove("hidden");
    $("hero-username").textContent = user.displayName || "слушатель";
    await loadTracks();
    showPage("home");
  } else {
    currentUser = null;
    allTracks = [];
    $("app").classList.add("hidden");
    $("auth-screen").classList.remove("hidden");
  }
});

// ─── LOAD TRACKS FROM FIRESTORE ─────────────────────────
async function loadTracks() {
  try {
    const q    = query(collection(db, "tracks"), where("uid", "==", currentUser.uid));
    const snap = await getDocs(q);
    allTracks  = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    allTracks.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
    localStorage.setItem(`nova_meta_${currentUser.uid}`, JSON.stringify(allTracks));
  } catch (e) {
    const cached = localStorage.getItem(`nova_meta_${currentUser.uid}`);
    if (cached) allTracks = JSON.parse(cached);
    toast("Офлайн режим — данные из кэша");
  }
  renderHome();
  renderLibrary();
}

// ─── UPLOAD ─────────────────────────────────────────────
const uploadZone = $("upload-zone");
const fileInput  = $("audio-file");

uploadZone.addEventListener("click", () => fileInput.click());
uploadZone.addEventListener("dragover",  e => { e.preventDefault(); uploadZone.style.borderColor = "var(--cyan)"; });
uploadZone.addEventListener("dragleave", () => uploadZone.style.borderColor = "");
uploadZone.addEventListener("drop", e => {
  e.preventDefault(); uploadZone.style.borderColor = "";
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("audio/")) handleUpload(file);
});
fileInput.addEventListener("change", () => { if (fileInput.files[0]) handleUpload(fileInput.files[0]); });
$("btn-upload").addEventListener("click", () => {
  if (fileInput.files[0]) handleUpload(fileInput.files[0]);
  else fileInput.click();
});

async function handleUpload(file) {
  const name   = ($("track-name").value.trim()   || file.name.replace(/\.[^.]+$/, "")).slice(0, 80);
  const artist = ($("track-artist").value.trim() || currentUser.displayName || "Unknown").slice(0, 60);
  const btn    = $("btn-upload");

  btn.disabled    = true;
  btn.textContent = "Сохранение…";

  try {
    // 1. Сохрани метаданные в Firestore
    const docRef = await addDoc(collection(db, "tracks"), {
      uid:      currentUser.uid,
      userName: currentUser.displayName || "Unknown",
      name, artist,
      plays:    0,
      likes:    0,
      likedBy:  [],
      createdAt: serverTimestamp(),
    });

    // 2. Сохрани аудио файл локально в IndexedDB
    await saveAudioIDB(docRef.id, file);

    // 3. Обнови локальный массив
    allTracks.unshift({ id: docRef.id, uid: currentUser.uid, name, artist, plays: 0, likes: 0, likedBy: [] });
    localStorage.setItem(`nova_meta_${currentUser.uid}`, JSON.stringify(allTracks));

    renderHome();
    renderLibrary();
    $("track-name").value   = "";
    $("track-artist").value = "";
    fileInput.value         = "";
    toast("✓ Трек добавлен!");
  } catch (e) {
    toast("Ошибка: " + e.message);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Загрузить";
  }
}

// ─── RENDER ─────────────────────────────────────────────
function renderHome() {
  const container = $("home-tracks");
  container.innerHTML = "";
  if (!allTracks.length) {
    container.innerHTML = `<div class="empty-state"><div class="es-icon">🎵</div>Загрузи свой первый трек</div>`;
    return;
  }
  allTracks.slice(0, 6).forEach(t => container.appendChild(makeTrackCard(t)));
}

function renderLibrary() {
  const container = $("library-tracks");
  container.innerHTML = "";
  let tracks = [...allTracks];

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    tracks = tracks.filter(t => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q));
  }
  if (sortMode === "plays") tracks.sort((a, b) => (b.plays || 0) - (a.plays || 0));
  if (sortMode === "name")  tracks.sort((a, b) => a.name.localeCompare(b.name));
  if (sortMode === "likes") tracks.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  if (sortMode === "date")  tracks.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

  if (!tracks.length) {
    container.innerHTML = `<div class="empty-state"><div class="es-icon">🔍</div>Ничего не найдено</div>`;
    return;
  }
  tracks.forEach((t, i) => container.appendChild(makeTrackRow(t, i)));
}

function isCurrentTrack(track) {
  return currentIndex >= 0 && allTracks[currentIndex]?.id === track.id;
}

function makeTrackCard(track) {
  const card = el("div", "track-card" + (isCurrentTrack(track) ? " playing" : ""));
  card.dataset.id = track.id;
  card.innerHTML = `
    <div class="tc-icon">♫</div>
    <div class="tc-name" title="${esc(track.name)}">${esc(track.name)}</div>
    <div class="tc-artist">${esc(track.artist)}</div>
    <div class="tc-meta">
      <span class="tc-plays">▶ ${fmtBig(track.plays || 0)}</span>
      <span class="tc-likes" data-id="${track.id}">♥ ${fmtBig(track.likes || 0)}</span>
    </div>`;
  card.addEventListener("click", (e) => {
    if (e.target.classList.contains("tc-likes")) { toggleLike(track.id); return; }
    playTrackById(track.id);
  });
  return card;
}

function makeTrackRow(track, idx) {
  const row = el("div", "track-row" + (isCurrentTrack(track) ? " playing" : ""));
  row.dataset.id = track.id;
  row.innerHTML = `
    <span class="tr-num">${idx + 1}</span>
    <div class="tr-icon">♫</div>
    <div class="tr-info">
      <div class="tr-name">${esc(track.name)}</div>
      <div class="tr-artist">${esc(track.artist)}</div>
    </div>
    <span class="tr-plays">▶ ${fmtBig(track.plays || 0)}</span>
    <span class="tr-like" data-id="${track.id}">♥ ${fmtBig(track.likes || 0)}</span>
    <span class="tr-del" data-id="${track.id}" title="Удалить">🗑</span>`;
  row.addEventListener("click", (e) => {
    const id = e.target.dataset?.id;
    if (e.target.classList.contains("tr-like")) { toggleLike(id); return; }
    if (e.target.classList.contains("tr-del"))  { deleteTrack(id); return; }
    playTrackById(track.id);
  });
  return row;
}

// ─── PLAYBACK ────────────────────────────────────────────
async function playTrackById(id) {
  const idx = allTracks.findIndex(t => t.id === id);
  if (idx < 0) return;
  currentIndex = idx;
  const track  = allTracks[idx];

  // Получи файл из IndexedDB
  const file = await getAudioIDB(id);
  if (!file) {
    toast("Аудио файл не найден на этом устройстве");
    return;
  }

  // Освободи предыдущий blob URL
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }

  currentBlobUrl = URL.createObjectURL(file);
  audio.src      = currentBlobUrl;
  audio.play().catch(() => toast("Не удалось воспроизвести"));

  isPlaying = true;
  $("btn-play").textContent    = "⏸";
  $("player-name").textContent   = track.name;
  $("player-artist").textContent = track.artist || "—";
  $("wave-rings").classList.add("playing-active");

  highlightPlaying(id);
  incrementPlays(id);
  initAudioViz();

  // Меняй цвет фона
  const colors = [
    "linear-gradient(135deg,#1A0A3E,#0A1A3E,#0A0A1A)",
    "linear-gradient(135deg,#0A2A1A,#1A0A3E,#0A0A1A)",
    "linear-gradient(135deg,#2A0A1A,#0A0A3E,#0A0A1A)",
  ];
  const bg = $("hero-bg");
  if (bg) bg.style.background = colors[Math.floor(Math.random() * colors.length)];
}

function highlightPlaying(id) {
  document.querySelectorAll(".track-card, .track-row").forEach(e => {
    e.classList.toggle("playing", e.dataset.id === id);
  });
}

async function incrementPlays(id) {
  try {
    await updateDoc(doc(db, "tracks", id), { plays: increment(1) });
    const t = allTracks.find(x => x.id === id);
    if (t) { t.plays = (t.plays || 0) + 1; localStorage.setItem(`nova_meta_${currentUser.uid}`, JSON.stringify(allTracks)); }
  } catch(e) {}
}

async function toggleLike(id) {
  if (!currentUser || !id) return;
  const t     = allTracks.find(x => x.id === id);
  if (!t) return;
  const uid   = currentUser.uid;
  const liked = (t.likedBy || []).includes(uid);
  try {
    const ref_ = doc(db, "tracks", id);
    if (liked) {
      await updateDoc(ref_, { likes: increment(-1), likedBy: arrayRemove(uid) });
      t.likes  = Math.max(0, (t.likes || 1) - 1);
      t.likedBy = (t.likedBy || []).filter(x => x !== uid);
    } else {
      await updateDoc(ref_, { likes: increment(1), likedBy: arrayUnion(uid) });
      t.likes  = (t.likes || 0) + 1;
      t.likedBy = [...(t.likedBy || []), uid];
    }
    localStorage.setItem(`nova_meta_${currentUser.uid}`, JSON.stringify(allTracks));
    renderHome(); renderLibrary();
    toast(liked ? "Лайк убран" : "♥ Нравится!");
  } catch(e) { toast("Ошибка лайка"); }
}

async function deleteTrack(id) {
  if (!confirm("Удалить трек?")) return;
  try {
    await deleteDoc(doc(db, "tracks", id));
    await deleteAudioIDB(id);
    allTracks = allTracks.filter(x => x.id !== id);
    localStorage.setItem(`nova_meta_${currentUser.uid}`, JSON.stringify(allTracks));
    renderLibrary(); renderHome();
    toast("🗑 Трек удалён");
    if (allTracks[currentIndex]?.id === id || currentIndex >= allTracks.length) {
      audio.pause(); audio.src = "";
      $("player-name").textContent   = "Выбери трек";
      $("player-artist").textContent = "—";
      isPlaying = false;
      $("btn-play").textContent = "▶";
      $("wave-rings").classList.remove("playing-active");
    }
  } catch(e) { toast("Ошибка удаления: " + e.message); }
}

// ─── PLAYER CONTROLS ────────────────────────────────────
$("btn-play").addEventListener("click", () => {
  if (!audio.src) return;
  if (isPlaying) {
    audio.pause(); isPlaying = false;
    $("btn-play").textContent = "▶";
    $("wave-rings").classList.remove("playing-active");
  } else {
    audio.play(); isPlaying = true;
    $("btn-play").textContent = "⏸";
    $("wave-rings").classList.add("playing-active");
  }
});

$("btn-next").addEventListener("click", () => {
  if (currentIndex < allTracks.length - 1) playTrackById(allTracks[currentIndex + 1].id);
});
$("btn-prev").addEventListener("click", () => {
  if (currentIndex > 0) playTrackById(allTracks[currentIndex - 1].id);
});

audio.addEventListener("timeupdate", () => {
  if (!audio.duration) return;
  const pct = audio.currentTime / audio.duration * 100;
  $("progress-fill").style.width  = pct + "%";
  $("time-cur").textContent   = fmt(audio.currentTime);
  $("time-total").textContent = fmt(audio.duration);
});

$("progress-bar").addEventListener("click", (e) => {
  const rect = e.currentTarget.getBoundingClientRect();
  audio.currentTime = (e.clientX - rect.left) / rect.width * audio.duration;
});

$("volume").addEventListener("input", (e) => { audio.volume = e.target.value; });
audio.volume = 0.7;

audio.addEventListener("ended", () => {
  $("btn-play").textContent = "▶"; isPlaying = false;
  $("wave-rings").classList.remove("playing-active");
  if (currentIndex < allTracks.length - 1) playTrackById(allTracks[currentIndex + 1].id);
});

$("player-like").addEventListener("click", () => {
  if (currentIndex < 0) return;
  toggleLike(allTracks[currentIndex].id);
});

// ─── CHARTS ─────────────────────────────────────────────
async function loadCharts() {
  const container = $("chart-tracks");
  container.innerHTML = `<div class="empty-state"><span class="spinner"></span></div>`;
  try {
    const snap   = await getDocs(collection(db, "tracks"));
    let tracks   = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    tracks.sort((a, b) => (b[chartMode] || 0) - (a[chartMode] || 0));
    const top    = tracks.slice(0, 20);
    const max    = top[0]?.[chartMode] || 1;
    container.innerHTML = "";
    if (!top.length) {
      container.innerHTML = `<div class="empty-state"><div class="es-icon">📊</div>Пока нет данных</div>`;
      return;
    }
    top.forEach((t, i) => {
      const row = el("div", "chart-row");
      const pct = Math.round((t[chartMode] || 0) / max * 100);
      row.innerHTML = `
        <span class="chart-rank ${rankClass(i)}">${i < 3 ? ["🥇","🥈","🥉"][i] : i+1}</span>
        <div class="chart-icon">♫</div>
        <div class="chart-info">
          <div class="chart-name">${esc(t.name)}</div>
          <div class="chart-artist">${esc(t.artist || t.userName)}</div>
        </div>
        <div class="chart-meta">
          <div class="chart-count">${fmtBig(t[chartMode] || 0)}</div>
          <div class="chart-label">${chartMode === "plays" ? "прослуш." : "лайков"}</div>
          <div class="chart-bar-wrap"><div class="chart-bar" style="width:${pct}%"></div></div>
        </div>`;
      row.addEventListener("click", () => {
        const own = allTracks.find(x => x.id === t.id);
        if (own) playTrackById(own.id);
        else toast("Этот трек не на твоём устройстве");
      });
      container.appendChild(row);
    });
  } catch(e) {
    container.innerHTML = `<div class="empty-state">Ошибка загрузки рейтинга</div>`;
  }
}

// ─── PROFILE ────────────────────────────────────────────
async function refreshProfile() {
  if (!currentUser) return;
  $("profile-name").textContent  = currentUser.displayName || "—";
  $("profile-email").textContent = currentUser.email;
  $("profile-avatar").textContent = (currentUser.displayName || "?")[0].toUpperCase();
  const total    = allTracks.reduce((s, t) => s + (t.plays || 0), 0);
  const totalLik = allTracks.reduce((s, t) => s + (t.likes || 0), 0);
  const top      = [...allTracks].sort((a, b) => (b.plays || 0) - (a.plays || 0))[0];
  $("stat-tracks").textContent = allTracks.length;
  $("stat-plays").textContent  = fmtBig(total);
  $("stat-likes").textContent  = fmtBig(totalLik);
  $("profile-top-track").textContent = top ? `${top.name} — ${fmtBig(top.plays)} прослуш.` : "—";
}

// ─── AUDIO VISUALIZER ───────────────────────────────────
function initAudioViz() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    const src = audioCtx.createMediaElementSource(audio);
    src.connect(analyser);
    analyser.connect(audioCtx.destination);
    analyser.fftSize = 128;
    drawViz();
  } catch(e) {}
}

function drawViz() {
  const canvas = $("visualizer-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const buf = new Uint8Array(analyser.frequencyBinCount);
  function loop() {
    animFrameId = requestAnimationFrame(loop);
    analyser.getByteFrequencyData(buf);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const W = canvas.width; const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const bw = W / buf.length;
    buf.forEach((v, i) => {
      const h    = (v / 255) * H * 0.7;
      const grad = ctx.createLinearGradient(0, H, 0, H - h);
      grad.addColorStop(0, "rgba(108,63,232,0.6)");
      grad.addColorStop(1, "rgba(0,212,255,0.8)");
      ctx.fillStyle = grad;
      ctx.fillRect(i * bw, H - h, bw - 2, h);
    });
  }
  loop();
}

// ─── NAVIGATION ─────────────────────────────────────────
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});
document.querySelectorAll(".sort-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sort-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    sortMode = btn.dataset.sort;
    renderLibrary();
  });
});
document.querySelectorAll(".chart-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chart-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartMode = btn.dataset.chart;
    loadCharts();
  });
});
$("search-input").addEventListener("input", (e) => { searchQuery = e.target.value; renderLibrary(); });

window.addEventListener("beforeunload", () => {
  if (animFrameId) cancelAnimationFrame(animFrameId);
  if (audioCtx) audioCtx.close();
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
});