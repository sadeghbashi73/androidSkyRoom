/**
 * Notifications + Permissions helper.
 */
import { screenShareStatus, canUseMic } from './capabilities.js';

export const Notify = {
  async isSupported() {
    return 'Notification' in window && 'serviceWorker' in navigator;
  },

  async permission() {
    if (!(await this.isSupported())) return 'unsupported';
    return Notification.permission;
  },

  async requestPermission() {
    if (!(await this.isSupported())) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    const result = await Notification.requestPermission();
    return result;
  },

  async show(title, options = {}) {
    if ((await this.permission()) !== 'granted') return null;
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      return reg.showNotification(title, {
        dir: 'rtl',
        lang: 'fa-IR',
        badge: '/icons/icon-72.png',
        icon: '/icons/icon-192.png',
        vibrate: [200, 100, 200],
        ...options,
      });
    }
    return new Notification(title, options);
  },
};

/**
 * Permissions helper - check microphone/camera state.
 *
 * IMPORTANT: these grants are scoped to THIS app's origin. A Skyroom class
 * runs on skyroom.online, so a grant made here does not satisfy Skyroom —
 * the user must accept the prompt inside Skyroom itself (once). See
 * capabilities.js for details.
 */
export const Perms = {
  async check(name) {
    try {
      if (!navigator.permissions) return 'prompt';
      const result = await navigator.permissions.query({ name });
      return result.state;
    } catch {
      return 'prompt';
    }
  },

  async requestMic() {
    if (!canUseMic()) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  },

  async requestCamera() {
    if (!canUseMic()) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Probe screen capture. Throws when the platform cannot do it at all
   * (every mobile browser) so callers can show a real reason instead of a
   * generic failure.
   */
  async requestScreen() {
    const { ok, reason } = screenShareStatus();
    if (!ok) {
      const err = new Error('Screen capture unavailable');
      err.code = reason;
      throw err;
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    stream.getTracks().forEach((t) => t.stop());
    return true;
  },
};

/**
 * Wake Lock - keeps the screen on during a class.
 */
export const WakeLock = {
  _sentinel: null,

  async acquire() {
    if (!('wakeLock' in navigator)) return false;
    if (this._sentinel) return true;
    try {
      this._sentinel = await navigator.wakeLock.request('screen');
      this._sentinel.addEventListener('release', () => { this._sentinel = null; });
      return true;
    } catch {
      return false;
    }
  },

  async release() {
    if (this._sentinel) {
      try { await this._sentinel.release(); } catch {}
      this._sentinel = null;
    }
  },

  isHeld() { return !!this._sentinel; },
};

/**
 * Toast UI helper.
 */
export function toast(message, type = 'info', duration = 3000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(-10px)';
    el.style.transition = 'all 200ms ease-in';
    setTimeout(() => el.remove(), 220);
  }, duration);
}