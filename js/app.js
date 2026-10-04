/**
 * Main app - dashboard logic.
 */
import { Storage, uid, normalizeSkyroomUrl, isLegacyBrokenUrl } from './storage.js';
import { Notify, Perms, WakeLock, toast } from './notifications.js';
import { platform, isNativeApp, APK_URL } from './capabilities.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------- State ---------- */
let state = {
  rooms: [],
  editingId: null,
  pendingDeleteId: null,
};

/* ---------- Boot ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  registerSW();
  await applyTheme();
  bindUI();
  await renderRooms();
  await registerInstallPrompt();
  await showAppBanner();
  await checkPermissionsOnFirstVisit();

  // If URL has #new, open add modal immediately
  if (location.hash === '#new') openModal();
  // Edit request from the room page (room.html → "ویرایش").
  const edit = location.hash.match(/^#edit-(.+)$/);
  if (edit) openModal(decodeURIComponent(edit[1]));
});

async function registerSW() {
  // Inside the Android app the pages are served from the APK itself.
  if (isNativeApp()) return;
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (e) {
      console.warn('SW registration failed', e);
    }
  }
}

/** Point Android browser users at the app — the only way to share their screen. */
async function showAppBanner() {
  if (!platform().android || isNativeApp()) return;
  if (await Storage.getSetting('appBannerDismissed', false)) return;
  $('#appBannerBtn').href = APK_URL;
  $('#appBanner').style.display = 'flex';
  $('#appBannerDismiss').addEventListener('click', async () => {
    $('#appBanner').style.display = 'none';
    await Storage.setSetting('appBannerDismissed', true);
  });
}

async function applyTheme() {
  const saved = await Storage.getSetting('theme', null);
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
  }
}

function bindUI() {
  $('#fabAdd').addEventListener('click', () => openModal());
  $('#themeToggle').addEventListener('click', toggleTheme);
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#modalBackdrop')) closeModal();
  });
  $('#roomForm').addEventListener('submit', handleFormSubmit);
  $('#searchInput').addEventListener('input', handleSearch);
  $('#permMicBtn').addEventListener('click', async () => {
    const ok = await Perms.requestMic();
    toast(
      ok ? 'میکروفون گوشی شما سالم است ✅' : 'دسترسی به میکروفون داده نشد',
      ok ? 'success' : 'error'
    );
  });
  $('#permCamBtn').addEventListener('click', async () => {
    const ok = await Perms.requestCamera();
    toast(
      ok ? 'دوربین گوشی شما سالم است ✅' : 'دسترسی به دوربین داده نشد',
      ok ? 'success' : 'error'
    );
  });
  // Theme button icon swap
  syncThemeIcon();
}

async function renderRooms() {
  state.rooms = await Storage.getAllRooms();
  const list = $('#roomList');
  const empty = $('#emptyState');
  const stats = $('#statsBar');

  // Stats
  if (state.rooms.length) {
    stats.style.display = 'grid';
    $('#statCount').textContent = state.rooms.length;
    $('#statRecent').textContent = state.rooms.filter(
      (r) => r.lastUsed && r.lastUsed > Date.now() - 7 * 24 * 60 * 60 * 1000
    ).length;
    $('#statSaved').textContent = state.rooms.filter((r) => r.username).length;
  } else {
    stats.style.display = 'none';
  }

  // Filter
  const q = ($('#searchInput').value || '').toLowerCase().trim();
  const rooms = q
    ? state.rooms.filter(
        (r) =>
          (r.name || '').toLowerCase().includes(q) ||
          (r.roomId || '').toLowerCase().includes(q) ||
          (r.url || '').toLowerCase().includes(q)
      )
    : state.rooms;

  if (!state.rooms.length) {
    empty.style.display = 'block';
    list.innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  if (!rooms.length) {
    list.innerHTML = `<div class="empty"><p class="empty-desc">نتیجه‌ای برای جستجوی شما پیدا نشد.</p></div>`;
    return;
  }

  list.innerHTML = rooms.map(roomCardHTML).join('');
  list.classList.add('fade-in');
  // Bind per-room actions
  list.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = el.dataset.action;
      const id = el.dataset.id;
      if (action === 'edit') openModal(id);
      if (action === 'delete') confirmDelete(id);
      if (action === 'open') openRoom(id, el);
    });
  });
  // Card click opens room
  list.querySelectorAll('.room-card').forEach((card) => {
    card.addEventListener('click', () => openRoom(card.dataset.id, card));
  });
}

function roomCardHTML(room) {
  const initial = (room.name || '?').charAt(0).toUpperCase();
  const last = room.lastUsed ? formatRelativeTime(room.lastUsed) : 'استفاده نشده';
  const hasLogin = room.username ? '👤' : '';
  const micReady = room.micReady
    ? '<span class="room-meta-item" title="مجوز میکروفون در اسکای‌روم داده شده">🎤 آماده</span>'
    : '';
  return `
    <div class="room-card" data-id="${escapeHtml(room.id)}">
      <div class="room-avatar">${escapeHtml(initial)}</div>
      <div class="room-info">
        <div class="room-name">${escapeHtml(room.name || 'بدون نام')}</div>
        <div class="room-meta">
          <span class="room-meta-item">📅 ${escapeHtml(last)}</span>
          ${hasLogin ? `<span class="room-meta-item">${hasLogin}</span>` : ''}
          ${micReady}
        </div>
      </div>
      <div class="room-actions">
        <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${escapeHtml(room.id)}" aria-label="ویرایش">✏️</button>
        <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${escapeHtml(room.id)}" aria-label="حذف">🗑️</button>
        <button class="btn btn-primary btn-sm" data-action="open" data-id="${escapeHtml(room.id)}">ورود</button>
      </div>
    </div>
  `;
}

async function openRoom(id, btn) {
  const room = await Storage.getRoom(id);
  if (!room) return;
  if (isLegacyBrokenUrl(room.url)) {
    // Saved by an older version that guessed a non-existent /chs/room/ link.
    toast('لینک این کلاس ناقص است. لینک کامل کلاس را از مدیر کلاس بگیرید و اینجا وارد کنید.', 'error', 6000);
    openModal(id);
    return;
  }
  // Update lastUsed
  room.lastUsed = Date.now();
  await Storage.updateRoom(room);
  // Navigate in the same tab. `window.open()` with popup features is blocked
  // or silently dropped in Android Chrome and in an installed PWA, which made
  // this button appear dead.
  openClass(room.url);
  // Visual feedback (painted before the navigation commits)
  if (btn) {
    btn.style.transform = 'scale(0.95)';
    setTimeout(() => (btn.style.transform = ''), 150);
  }
}

function openClass(url) {
  if (!url) return;
  WakeLock.acquire();
  location.assign(url);
}

/* ---------- Modal ---------- */
function openModal(id = null) {
  state.editingId = id;
  const modal = $('#modalBackdrop');
  const form = $('#roomForm');
  const title = $('#modalTitle');

  if (id) {
    const room = state.rooms.find((r) => r.id === id);
    if (!room) return;
    title.textContent = 'ویرایش کلاس';
    form.name.value = room.name || '';
    form.url.value = room.url || '';
    form.username.value = room.username || '';
    form.password.value = room.password || '';
    form.notes.value = room.notes || '';
  } else {
    title.textContent = 'افزودن کلاس جدید';
    form.reset();
  }
  modal.classList.add('open');
  setTimeout(() => form.name.focus(), 200);
}

function closeModal() {
  $('#modalBackdrop').classList.remove('open');
  state.editingId = null;
}

/* ---------- Form ---------- */
async function handleFormSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const urlInput = form.url.value.trim();
  const norm = normalizeSkyroomUrl(urlInput);
  if (!norm) {
    toast('لینک کامل کلاس را وارد کنید؛ مثل https://www.skyroom.online/ch/نام-حساب/نام-اتاق', 'error', 6000);
    return;
  }
  const room = {
    id: state.editingId || uid(),
    name: form.name.value.trim() || 'بدون نام',
    url: norm.url,
    roomId: norm.roomId,
    username: form.username.value.trim() || null,
    password: form.password.value || null,
    notes: form.notes.value.trim() || null,
    createdAt: state.editingId ? null : Date.now(),
    // Preserve the mic confirmation and last-used stamp across edits.
    micReady: state.editingId
      ? state.rooms.find((r) => r.id === state.editingId)?.micReady === true
      : false,
    lastUsed: state.editingId
      ? state.rooms.find((r) => r.id === state.editingId)?.lastUsed
      : undefined,
  };
  try {
    if (state.editingId) {
      const existing = await Storage.getRoom(state.editingId);
      room.createdAt = existing?.createdAt || Date.now();
      room.lastUsed = existing?.lastUsed ?? room.lastUsed;
      await Storage.updateRoom(room);
      toast('کلاس به‌روزرسانی شد', 'success');
    } else {
      await Storage.addRoom(room);
      toast('کلاس اضافه شد', 'success');
    }
    closeModal();
    await renderRooms();
  } catch (e) {
    toast('خطا در ذخیره‌سازی', 'error');
    console.error(e);
  }
}

/* ---------- Delete ---------- */
function confirmDelete(id) {
  const room = state.rooms.find((r) => r.id === id);
  if (!room) return;
  if (confirm(`کلاس «${room.name}» حذف شود؟`)) {
    Storage.deleteRoom(id).then(async () => {
      toast('کلاس حذف شد', 'success');
      await renderRooms();
    });
  }
}

/* ---------- Search ---------- */
let searchTimer = null;
function handleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderRooms(), 120);
}

/* ---------- Theme ---------- */
async function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  await Storage.setSetting('theme', next);
  syncThemeIcon();
}

function syncThemeIcon() {
  const btn = $('#themeToggle');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.textContent = isDark ? '☀️' : '🌙';
  btn.setAttribute('aria-label', isDark ? 'حالت روشن' : 'حالت تاریک');
}

/* ---------- Permissions banner ---------- */
async function checkPermissionsOnFirstVisit() {
  const seen = await Storage.getSetting('permsCheckDone', false);
  if (seen) return;
  // Wait a moment so the page is settled
  setTimeout(async () => {
    const micGranted = (await Perms.check('microphone')) === 'granted';
    const camGranted = (await Perms.check('camera')) === 'granted';
    if (!micGranted || !camGranted) {
      $('#permsBanner').style.display = 'block';
      $('#permsBannerClose').addEventListener('click', async () => {
        await Storage.setSetting('permsCheckDone', true);
        $('#permsBanner').style.display = 'none';
      }, { once: true });
    } else {
      await Storage.setSetting('permsCheckDone', true);
    }
  }, 800);
}

/* ---------- Install prompt ---------- */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('#installBanner').style.display = 'flex';
});
async function registerInstallPrompt() {
  const btn = $('#installBtn');
  const dismiss = $('#installDismiss');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) {
      toast('برای نصب، از منوی مرورگر گزینه Add to Home screen را انتخاب کنید', 'info', 5000);
      return;
    }
    deferredInstallPrompt.prompt();
    const choice = await deferredInstallPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      toast('نصب شروع شد', 'success');
    }
    deferredInstallPrompt = null;
    $('#installBanner').style.display = 'none';
  });
  dismiss.addEventListener('click', () => {
    $('#installBanner').style.display = 'none';
  });
}

/* ---------- Helpers ---------- */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (m < 1) return 'همین الان';
  if (h < 1) return `${m} دقیقه پیش`;
  if (d < 1) return `${h} ساعت پیش`;
  if (d < 7) return `${d} روز پیش`;
  return new Date(ts).toLocaleDateString('fa-IR');
}