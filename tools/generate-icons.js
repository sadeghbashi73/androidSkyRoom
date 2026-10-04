/**
 * Generate PNG icons from icon.svg.
 *
 * Zero dependencies: renders icon.svg with a small built-in rasterizer and
 * encodes PNG with Node's zlib. No npm install, no network, no sharp.
 *
 * Usage:
 *   node tools/generate-icons.js
 *
 * Output: writes PNGs into ./icons/ directory.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_SIZES = [
  { name: 'icon-72.png', size: 72 },
  { name: 'icon-96.png', size: 96 },
  { name: 'icon-128.png', size: 128 },
  { name: 'icon-144.png', size: 144 },
  { name: 'icon-152.png', size: 152 },
  { name: 'icon-180.png', size: 180 }, // Apple touch icon
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-384.png', size: 384 },
  { name: 'icon-512.png', size: 512 },
  { name: 'icon-maskable-512.png', size: 512, maskable: true },
];

const OUT_DIR = path.resolve(__dirname, '..', 'icons');
const SS = 4; // supersampling factor per axis (AA quality)

/* ------------------------------------------------------------------ *
 * Minimal PNG encoder (8-bit RGBA, no interlace)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Rasterizer — mirrors the geometry in icons/icon.svg (512x512 viewBox)
 * ------------------------------------------------------------------ */

const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];

const BG_A = hex('#6366f1');
const BG_B = hex('#8b5cf6');
const BG_C = hex('#ec4899');
const SCREEN_A = hex('#1e293b');
const SCREEN_B = hex('#0f172a');
const DOT_COLORS = [
  [160, 380, hex('#a5b4fc')],
  [220, 380, hex('#c4b5fd')],
  [292, 380, hex('#f9a8d4')],
  [352, 380, hex('#a5b4fc')],
];
const TRIANGLE = [
  [232, 222],
  [232, 290],
  [296, 256],
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function bgGradient(x, y) {
  const t = clamp01((x + y) / 1024);
  return t < 0.5 ? lerp3(BG_A, BG_B, t * 2) : lerp3(BG_B, BG_C, (t - 0.5) * 2);
}

function screenGradient(x) {
  return lerp3(SCREEN_A, SCREEN_B, clamp01(x / 512));
}

/** Signed distance to an axis-aligned rounded rect. Negative = inside. */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const mx = Math.max(qx, 0);
  const my = Math.max(qy, 0);
  return Math.hypot(mx, my) + Math.min(Math.max(qx, qy), 0) - r;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(wx - vx * t, wy - vy * t);
}

/** Signed distance to the play triangle. Negative = inside. */
function sdTriangle(px, py) {
  let inside = true;
  let dmin = Infinity;
  for (let i = 0; i < 3; i++) {
    const a = TRIANGLE[i];
    const b = TRIANGLE[(i + 1) % 3];
    const cross = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
    if (cross > 0) inside = false;
    dmin = Math.min(dmin, distToSegment(px, py, a[0], a[1], b[0], b[1]));
  }
  return inside ? -dmin : dmin;
}

/** source-over composite. Channels are 0-255, alpha 0-255. */
function over(dst, rgb, alpha) {
  if (alpha <= 0) return dst;
  const sa = alpha / 255;
  const da = dst[3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return [0, 0, 0, 0];
  return [
    (rgb[0] * sa + dst[0] * da * (1 - sa)) / oa,
    (rgb[1] * sa + dst[1] * da * (1 - sa)) / oa,
    (rgb[2] * sa + dst[2] * da * (1 - sa)) / oa,
    oa * 255,
  ];
}

/** Coverage from a signed distance, in icon units. */
const cover = (sd) => clamp01(0.5 - sd);

/**
 * Sample the icon at a point in icon space (0..512).
 * `maskable` renders the full-bleed gradient background that Android
 * adaptive icons need, so corners are never transparent.
 */
function sample(x, y, maskable) {
  let dst = [0, 0, 0, 0];

  if (maskable) {
    dst = [...bgGradient(x, y), 255];
  } else {
    const d = sdRoundRect(x, y, 256, 256, 256, 256, 96);
    const a = cover(d) * 255;
    if (a > 0) dst = [...bgGradient(x, y), a];
  }

  // Screen panel: dark gradient fill + white outline (group opacity 0.95).
  const dScreen = sdRoundRect(x, y, 256, 256, 176, 176, 48);
  const fillA = cover(dScreen) * 0.95;
  if (fillA > 0) dst = over(dst, screenGradient(x), fillA * 255);
  const strokeA = cover(Math.abs(dScreen) - 3) * 0.95;
  if (strokeA > 0) dst = over(dst, [255, 255, 255], strokeA * 255);

  // Play ring + triangle.
  const dCircle = Math.hypot(x - 256, y - 256);
  const ringA = cover(Math.abs(dCircle - 80) - 7) * 0.9;
  if (ringA > 0) dst = over(dst, [255, 255, 255], ringA * 255);
  const triA = cover(sdTriangle(x, y));
  if (triA > 0) dst = over(dst, [255, 255, 255], triA * 255);

  // Student dots.
  for (const [cx, cy, color] of DOT_COLORS) {
    const a = cover(Math.hypot(x - cx, y - cy) - 14);
    if (a > 0) dst = over(dst, color, a * 255);
  }

  return dst;
}

function render(size, maskable) {
  // Maskable icons keep content inside the 80% safe zone.
  const contentScale = maskable ? 0.62 : 1;
  const buf = Buffer.alloc(size * size * 4);
  const n = SS * SS;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const dx = ((px + (sx + 0.5) / SS) / size) * 512;
          const dy = ((py + (sy + 0.5) / SS) / size) * 512;
          const ix = (dx - 256) / contentScale + 256;
          const iy = (dy - 256) / contentScale + 256;
          const c = sample(ix, iy, maskable);
          // premultiplied accumulation, un-premultiplied on write
          ar += c[0] * c[3];
          ag += c[1] * c[3];
          ab += c[2] * c[3];
          aa += c[3];
        }
      }
      const o = (px * 4) + py * size * 4;
      if (aa > 0) {
        buf[o] = Math.round(ar / aa);
        buf[o + 1] = Math.round(ag / aa);
        buf[o + 2] = Math.round(ab / aa);
      }
      buf[o + 3] = Math.round(aa / n);
    }
  }

  return encodePNG(size, size, buf);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const { name, size, maskable } of ICON_SIZES) {
    const outPath = path.join(OUT_DIR, name);
    fs.writeFileSync(outPath, render(size, !!maskable));
    console.log(`✅ ${name} (${size}×${size}${maskable ? ', maskable' : ''})`);
  }
  console.log('\n🎉 همه آیکون‌ها ساخته شدند.');
}

main();
