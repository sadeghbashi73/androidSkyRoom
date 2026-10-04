/*
 * Injected into every page by the Android app.
 *
 * Android WebView has no navigator.mediaDevices.getDisplayMedia(). This shim
 * provides one: the native side captures the phone screen with
 * MediaProjection and pushes JPEG frames here; we turn them into a real
 * MediaStreamTrack that Skyroom can send over WebRTC like any desktop share.
 *
 * Native → JS callbacks: __srsOnStart(w, h), __srsFrame(base64), __srsOnEnd(), __srsOnError(msg)
 * JS → native: SkyroomNative.requestScreen(), SkyroomNative.stopScreen()
 */
(function () {
  'use strict';
  if (window.__srsInstalled) return;
  var N = window.SkyroomNative;
  var md = navigator.mediaDevices;
  if (!N || !md) return;
  window.__srsInstalled = true;

  var pending = null; // {resolve, reject} while the consent dialog is open
  var active = null;  // current capture session

  function decode(b64) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return new Blob([u], { type: 'image/jpeg' });
  }

  function err(name, msg) {
    try { return new DOMException(msg, name); } catch (e) {
      var x = new Error(msg); x.name = name; return x;
    }
  }

  // Prefer a track generator: it does not depend on the page's rendering
  // loop, so frames keep flowing while the user is in another app and this
  // page is hidden. Fall back to canvas.captureStream() on older WebViews.
  function makeSink(w, h) {
    if (typeof window.MediaStreamTrackGenerator === 'function' &&
        typeof window.VideoFrame === 'function') {
      var gen = new MediaStreamTrackGenerator({ kind: 'video' });
      var writer = gen.writable.getWriter();
      return {
        track: gen,
        draw: function (bmp) {
          var f = new VideoFrame(bmp, { timestamp: Math.round(performance.now() * 1000) });
          return writer.write(f).finally(function () { f.close(); });
        },
        close: function () { try { writer.close(); } catch (e) {} },
      };
    }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    var stream = canvas.captureStream(0);
    var track = stream.getVideoTracks()[0];
    return {
      track: track,
      draw: function (bmp) {
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width; canvas.height = bmp.height;
        }
        ctx.drawImage(bmp, 0, 0);
        if (track.requestFrame) track.requestFrame();
        return Promise.resolve();
      },
      close: function () {},
    };
  }

  function finish(notifyNative) {
    var s = active;
    active = null;
    if (!s) return;
    if (notifyNative) { try { N.stopScreen(); } catch (e) {} }
    s.sink.close();
    s.origStop.call(s.track);
    try { s.track.dispatchEvent(new Event('ended')); } catch (e) {}
    if (typeof s.track.onended === 'function') { try { s.track.onended(new Event('ended')); } catch (e) {} }
  }

  window.__srsOnStart = function (w, h) {
    var p = pending;
    pending = null;
    if (!p) { try { N.stopScreen(); } catch (e) {} return; }

    var sink = makeSink(w, h);
    var track = sink.track;
    var origStop = track.stop;
    var origSettings = track.getSettings ? track.getSettings.bind(track) : function () { return {}; };
    var size = { w: w, h: h };

    track.stop = function () { finish(true); };
    track.getSettings = function () {
      var s = origSettings() || {};
      s.width = size.w; s.height = size.h;
      s.displaySurface = 'monitor';
      s.logicalSurface = true;
      s.cursor = 'never';
      return s;
    };
    try {
      Object.defineProperty(track, 'label', { value: 'screen:0:0', configurable: true });
    } catch (e) {}

    active = { sink: sink, track: track, origStop: origStop, busy: false, size: size };
    p.resolve(new MediaStream([track]));
  };

  window.__srsFrame = function (b64) {
    var s = active;
    if (!s || s.busy) return; // drop frames rather than queue them
    s.busy = true;
    createImageBitmap(decode(b64))
      .then(function (bmp) {
        s.size.w = bmp.width; s.size.h = bmp.height;
        return s.sink.draw(bmp).finally(function () { bmp.close(); });
      })
      .catch(function () {})
      .then(function () { s.busy = false; });
  };

  window.__srsOnEnd = function () {
    if (pending) { pending.reject(err('NotAllowedError', 'Permission denied')); pending = null; }
    finish(false);
  };

  window.__srsOnError = function (msg) {
    if (pending) { pending.reject(err('NotAllowedError', msg || 'Permission denied')); pending = null; }
    finish(false);
  };

  function getDisplayMedia() {
    if (pending) return Promise.reject(err('InvalidStateError', 'A request is already pending'));
    if (active) finish(true);
    return new Promise(function (resolve, reject) {
      pending = { resolve: resolve, reject: reject };
      try { N.requestScreen(); } catch (e) {
        pending = null;
        reject(err('NotSupportedError', 'Screen capture unavailable'));
      }
    });
  }

  try {
    Object.defineProperty(md, 'getDisplayMedia', {
      value: getDisplayMedia, configurable: true, writable: true,
    });
  } catch (e) {
    md.getDisplayMedia = getDisplayMedia;
  }

  // Desktop mode: present as a desktop browser so Skyroom shows its full
  // presenter toolbar (including Share screen), which it hides on phones.
  if (N.isDesktopMode && N.isDesktopMode()) {
    try {
      Object.defineProperty(navigator, 'platform', { get: function () { return 'Win32'; }, configurable: true });
      if (navigator.userAgentData) {
        var uad = navigator.userAgentData;
        var fake = {
          brands: uad.brands, mobile: false, platform: 'Windows',
          getHighEntropyValues: function (h) {
            return uad.getHighEntropyValues(h).then(function (v) {
              v.mobile = false; v.platform = 'Windows'; return v;
            });
          },
          toJSON: function () { return { brands: uad.brands, mobile: false, platform: 'Windows' }; },
        };
        Object.defineProperty(navigator, 'userAgentData', { get: function () { return fake; }, configurable: true });
      }
    } catch (e) {}
  }
})();
