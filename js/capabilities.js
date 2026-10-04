/**
 * Capability detection — reports what this browser/device can *actually* do.
 *
 * Why this module exists
 * ----------------------
 * Screen sharing on Android is not a bug to be fixed; it does not exist at the
 * platform level:
 *
 *   - `getDisplayMedia()` is not implemented by any mobile browser. Chrome
 *     Android, Samsung Internet, Firefox Android and Android WebView all lack
 *     it. Chrome 72–88 exposed it but every call failed with
 *     `NotAllowedError` (crbug.com/40418135), and it was removed afterwards.
 *   - Skyroom itself disables screen sharing on Android and iOS; sharing is
 *     desktop-only for their clients.
 *
 * So the UI must never offer a "share screen" button that cannot work. This
 * module detects the real state and feeds honest alternatives to the UI.
 */

/** @typedef {{android:boolean, ios:boolean, mobile:boolean}} Platform */

/**
 * The Android app ("اسکای‌روم پرزنتر", folder android/) hosts Skyroom in a
 * WebView and provides a real getDisplayMedia() backed by Android's
 * MediaProjection. That is the only way to share an Android screen.
 */
export const APK_URL = 'https://github.com/sadeghbashi73/androidSkyRoom/releases/latest/download/androidSkyRoom.apk';

/** True when running inside the Android app. */
export function isNativeApp() {
  try { return !!window.SkyroomNative?.isApp?.(); } catch { return false; }
}

/** @returns {Platform} */
export function platform() {
  const ua = navigator.userAgent || '';
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return { android, ios, mobile: android || ios };
}

/** True if this browser can capture a display/screen at all. */
export function canShareScreen() {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/** True if microphone capture is available in this browser. */
export function canUseMic() {
  return typeof navigator.mediaDevices?.getUserMedia === 'function';
}

/**
 * Screen-share availability, with a machine-readable reason.
 * @returns {{ok:boolean, reason:'ok'|'app'|'insecure'|'mobile'|'unsupported'}}
 */
export function screenShareStatus() {
  if (isNativeApp()) return { ok: true, reason: 'app' };
  if (!window.isSecureContext) return { ok: false, reason: 'insecure' };
  if (canShareScreen()) return { ok: true, reason: 'ok' };
  return { ok: false, reason: platform().mobile ? 'mobile' : 'unsupported' };
}

/** Persian, user-facing explanation of the screen-share situation. */
export function screenShareMessage() {
  const { ok, reason } = screenShareStatus();
  if (reason === 'app')
    return 'اشتراک صفحه در این اپ فعال است. داخل کلاس دکمه «اشتراک صفحه» اسکای‌روم را بزنید، در پنجره اندروید «Start now / شروع» را انتخاب کنید و بعد به هر برنامه‌ای (پی‌دی‌اف، گالری، پاورپوینت) بروید؛ صفحه گوشی برای کلاس ارسال می‌شود.';
  if (ok) return 'اشتراک صفحه روی این مرورگر پشتیبانی می‌شود.';
  if (reason === 'insecure')
    return 'اشتراک صفحه فقط روی اتصال امن (HTTPS) فعال می‌شود.';
  if (reason === 'mobile' && platform().android)
    return 'مرورگرهای اندروید اشتراک صفحه ندارند. اپ اندروید «اسکای‌روم پرزنتر» را نصب کنید؛ کلاس را داخل همان اپ باز کنید تا اشتراک صفحه، میکروفون و دوربین کار کنند.';
  if (reason === 'mobile')
    return 'اشتراک صفحه روی مرورگرهای موبایل پشتیبانی نمی‌شود.';
  return 'این مرورگر از اشتراک صفحه پشتیبانی نمی‌کند. از کروم، فایرفاکس یا اپرا روی کامپیوتر استفاده کنید.';
}

/**
 * What a presenter can realistically do on this device instead of
 * screen sharing. These all work in Skyroom's own mobile/web client.
 */
export function presenterAlternatives() {
  return [
    {
      icon: '📄',
      title: 'اشتراک فایل (پی‌دی‌اف و پاورپوینت)',
      desc: 'از نوار ابزار داخل کلاس، فایل را آپلود کنید. روی موبایل کار می‌کند.',
    },
    {
      icon: '🖍️',
      title: 'وایت‌برد اسکای‌روم',
      desc: 'روی تخته بنویسید و برای همه نمایش دهید؛ نیازی به اشتراک صفحه ندارد.',
    },
    {
      icon: '🖼️',
      title: 'نمایش تصویر و اسلاید',
      desc: 'تصاویر و اسلایدها را به‌عنوان محتوای کلاس به اشتراک بگذارید.',
    },
    {
      icon: '💻',
      title: 'اشتراک صفحه کامپیوتر',
      desc: 'اسکای‌روم را روی کامپیوتر باز کنید و از همان‌جا صفحه را Share کنید. گوشی را می‌توانید با Cast یا scrcpy به کامپیوتر وصل کنید.',
    },
  ];
}

/**
 * Mic/camera permission for a given origin, as far as the web platform
 * allows us to see it.
 *
 * NOTE: `navigator.permissions` only ever reflects the *current* origin.
 * A Skyroom class runs on skyroom.online, so any grant made here is scoped
 * to this app's own origin and does not carry over. Callers must treat the
 * result as advisory only.
 *
 * @returns {Promise<'granted'|'denied'|'prompt'|'unknown'>}
 */
export async function originPermission(name) {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const res = await navigator.permissions.query({ name });
    return res.state;
  } catch {
    return 'unknown';
  }
}
