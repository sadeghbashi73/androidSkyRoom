/**
 * Room launcher page — pre-flight checks before opening Skyroom.
 *
 * Design note: Skyroom runs on its own origin (skyroom.online), so this page
 * cannot grant it microphone access or reach into its UI. Anything that would
 * cross that boundary is stated plainly instead of faked. See
 * js/capabilities.js for the platform constraints.
 */
import { Storage, normalizeSkyroomUrl } from './storage.js';
import { Perms, WakeLock, toast } from './notifications.js';
import {
  screenShareStatus,
  screenShareMessage,
  presenterAlternatives,
  canUseMic,
  platform,
  isNativeApp,
  APK_URL,
} from './capabilities.js';

const $ = (s, r = document) => r.querySelector(s);

const state = { room: null, passwordRevealed: false };

document.addEventListener('DOMContentLoaded', async () => {
  bindUI();
  await loadRoom();
  renderScreenShare();
  renderMicSection();
});

/* ------------------------------------------------------------------ *
 * Room loading
 * ------------------------------------------------------------------ */

async function loadRoom() {
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  let room = null;

  if (id) {
    room = await Storage.getRoom(id);
  } else {
    const raw = params.get('url');
    if (raw) {
      const norm = normalizeSkyroomUrl(raw);
      if (norm) room = { name: 'کلاس مستقیم', url: norm.url, roomId: norm.roomId };
    }
  }

  if (!room) {
    toast('کلاس پیدا نشد', 'error');
    setTimeout(() => (location.href = './index.html'), 1200);
    return;
  }

  state.room = room;
  $('#roomName').textContent = room.name || 'کلاس بدون نام';
  $('#roomId').textContent = room.roomId ? `شناسه: ${room.roomId}` : room.url;
  $('#roomUrl').value = room.url || '';

  if (room.notes) {
    $('#notesSection').style.display = 'block';
    $('#roomNotes').textContent = room.notes;
  }
  if (room.username) {
    $('#loginInfo').style.display = 'block';
    $('#loginUsername').textContent = room.username;
    renderPassword();
  }
  renderMicSection();
}

function renderPassword() {
  const pw = state.room?.password;
  const el = $('#loginPassword');
  if (!pw) {
    el.textContent = '—';
    return;
  }
  el.textContent = state.passwordRevealed ? pw : '•'.repeat(pw.length);
  el.style.fontFamily = state.passwordRevealed ? 'inherit' : 'monospace';
  el.style.letterSpacing = state.passwordRevealed ? 'normal' : '2px';
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

/**
 * Open the class. We navigate in the same tab on purpose: `window.open()`
 * with popup features is blocked or silently dropped in Android Chrome and
 * inside an installed PWA, which left the button doing nothing.
 */
function openClass() {
  if (!state.room?.url) return;
  // Best effort: keep this screen awake if the browser allows it, though the
  // lock is released as soon as we leave the page.
  WakeLock.acquire();
  location.assign(state.room.url);
}

/* ------------------------------------------------------------------ *
 * Microphone / camera
 * ------------------------------------------------------------------ */

function renderMicSection() {
  const chip = $('#micReadyChip');
  if (state.room?.micReady) {
    chip.textContent = 'مجاز شده';
    chip.className = 'perm-state granted';
  } else {
    chip.textContent = 'در انتظار تأیید';
    chip.className = 'perm-state prompt';
  }

  const supported = canUseMic();
  for (const id of ['#grantMic', '#grantCam']) {
    const btn = $(id);
    btn.disabled = !supported;
    if (!supported) btn.textContent = 'پشتیبانی نمی‌شود';
  }
}

function bindUI() {
  $('#backBtn').addEventListener('click', () => {
    if (history.length > 1) history.back();
    else location.href = './index.html';
  });
  $('#openBtn').addEventListener('click', openClass);
  $('#wakeBtn').addEventListener('click', toggleWake);
  $('#shareBtn').addEventListener('click', shareRoom);
  $('#editBtn').addEventListener('click', () => {
    const id = new URLSearchParams(location.search).get('id');
    if (id) location.href = `./index.html#edit-${id}`;
  });

  // Device self-test (scoped to this origin — not to Skyroom).
  $('#grantMic').addEventListener('click', async () => {
    const ok = await Perms.requestMic();
    toast(
      ok ? 'میکروفون این دستگاه سالم است' : 'دسترسی میکروفون داده نشد',
      ok ? 'success' : 'error'
    );
  });
  $('#grantCam').addEventListener('click', async () => {
    const ok = await Perms.requestCamera();
    toast(
      ok ? 'دوربین این دستگاه سالم است' : 'دسترسی دوربین داده نشد',
      ok ? 'success' : 'error'
    );
  });

  // Persist the user's confirmation that Skyroom already has mic access.
  $('#micConfirmBtn').addEventListener('click', async () => {
    if (!state.room) return;
    state.room.micReady = !state.room.micReady;
    await Storage.updateRoom(state.room);
    renderMicSection();
    toast(
      state.room.micReady ? 'عالی! کلاس آماده است' : 'تأیید لغو شد',
      state.room.micReady ? 'success' : 'info'
    );
  });

  $('#micHelpBtn').addEventListener('click', () => {
    const box = $('#micHelp');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
  });

  $('#grantScreen').addEventListener('click', testScreenShare);

  // Credentials + URL copy helpers.
  $('#copyUrl').addEventListener('click', () => copy(state.room?.url, 'لینک کپی شد'));
  $('#copyUsername').addEventListener('click', () =>
    copy(state.room?.username, 'نام کاربری کپی شد')
  );
  $('#copyPassword').addEventListener('click', () =>
    copy(state.room?.password, 'رمز عبور کپی شد')
  );
  $('#revealPassword').addEventListener('click', () => {
    state.passwordRevealed = !state.passwordRevealed;
    $('#revealPassword').textContent = state.passwordRevealed ? '🙈' : '👁️';
    renderPassword();
  });
}

/* ------------------------------------------------------------------ *
 * Screen sharing
 * ------------------------------------------------------------------ */

function renderScreenShare() {
  const { ok, reason } = screenShareStatus();
  const getApp = $('#getApp');
  if (reason === 'mobile' && platform().android) {
    getApp.href = APK_URL;
    getApp.style.display = 'block';
  }
  if (isNativeApp()) {
    $('#micAppNote').style.display = 'block';
  }
  const chip = $('#permScreenState');
  const msg = $('#screenMsg');
  const testBtn = $('#grantScreen');
  const altList = $('#altList');

  msg.textContent = screenShareMessage();

  if (ok) {
    chip.textContent = reason === 'app' ? 'فعال در اپ' : 'پشتیبانی می‌شود';
    chip.className = 'perm-state granted';
    testBtn.style.display = 'block';
    altList.style.display = 'none';
    return;
  }

  chip.textContent = 'غیرفعال';
  chip.className = 'perm-state denied';
  testBtn.style.display = 'none';

  // Idempotent: clear any previously rendered entries.
  altList.textContent = '';

  for (const alt of presenterAlternatives()) {
    const item = document.createElement('div');
    item.className = 'alt-item';
    const icon = document.createElement('div');
    icon.className = 'alt-icon';
    icon.textContent = alt.icon;
    const body = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'alt-title';
    title.textContent = alt.title;
    const desc = document.createElement('div');
    desc.className = 'alt-desc';
    desc.textContent = alt.desc;
    body.append(title, desc);
    item.append(icon, body);
    altList.appendChild(item);
  }
}

async function testScreenShare() {
  try {
    await Perms.requestScreen();
    toast('اشتراک صفحه روی این مرورگر کار می‌کند ✅', 'success');
  } catch (e) {
    const messages = {
      mobile: 'اشتراک صفحه روی موبایل پشتیبانی نمی‌شود',
      insecure: 'برای این قابلیت باید از HTTPS استفاده کنید',
      unsupported: 'این مرورگر از اشتراک صفحه پشتیبانی نمی‌کند',
    };
    toast(messages[e.code] || 'اشتراک صفحه انجام نشد', 'error', 4500);
  }
}

/* ------------------------------------------------------------------ *
 * Share / wake lock / clipboard
 * ------------------------------------------------------------------ */

async function shareRoom() {
  const url = state.room?.url;
  if (!url) return;
  if (navigator.share) {
    try {
      await navigator.share({
        title: state.room.name || 'کلاس اسکای‌روم',
        text: 'به کلاس من بپیوندید',
        url,
      });
    } catch {
      /* user dismissed the sheet */
    }
  } else {
    await copy(url, 'لینک کپی شد');
  }
}

async function toggleWake(e) {
  const btn = e.currentTarget;
  if (WakeLock.isHeld()) {
    await WakeLock.release();
    btn.textContent = '🔆 روشن نگه‌داشتن صفحه';
    toast('قفل صفحه غیرفعال شد', 'info');
  } else {
    const ok = await WakeLock.acquire();
    btn.textContent = ok ? '✅ صفحه روشن می‌ماند' : '🔆 روشن نگه‌داشتن صفحه';
    toast(
      ok ? 'قفل صفحه فعال شد (فقط برای همین صفحه)' : 'این مرورگر پشتیبانی نمی‌کند',
      ok ? 'success' : 'error'
    );
  }
}

/** Clipboard write with a fallback for non-secure contexts. */
async function copy(text, okMessage) {
  if (!text) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(okMessage, 'success');
  } catch {
    toast('کپی نشد؛ متن را دستی انتخاب کنید', 'error');
  }
}
