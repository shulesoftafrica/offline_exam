/**
 * Generates the PWA icons as real PNGs with no image-library dependency.
 *
 * The mark is deliberately plain: a dark slate tile with a white "E" (for Exam) and a small
 * amber dot standing for "saved offline". Replace `public/icons/*` with the school's own
 * artwork whenever design supplies it — nothing in the app depends on these pixels.
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public', 'icons');

const BG = [15, 23, 42, 255]; // slate-900, matches theme_color
const FG = [248, 250, 252, 255]; // slate-50
const ACCENT = [245, 158, 11, 255]; // amber-500

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // no filter
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixels(x, y);
      const p = rowStart + 1 + x * 4;
      raw[p] = r;
      raw[p + 1] = g;
      raw[p + 2] = b;
      raw[p + 3] = a;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** @param {number} size @param {boolean} maskable extra safe-area padding for maskable icons */
function icon(size, maskable) {
  const pad = maskable ? 0.22 : 0.16;
  const inset = size * pad;
  const glyphW = size - inset * 2;
  const stroke = Math.max(2, Math.round(glyphW * 0.16));
  const left = inset;
  const right = size - inset;
  const top = inset;
  const bottom = size - inset;
  const mid = size / 2 - stroke / 2;
  const dotR = Math.max(3, Math.round(size * 0.075));
  const dotCx = right - dotR * 0.9;
  const dotCy = bottom - dotR * 0.9;

  return png(size, (x, y) => {
    // amber "saved" dot, bottom right
    if ((x - dotCx) ** 2 + (y - dotCy) ** 2 <= dotR * dotR) return ACCENT;
    // the letter E: spine plus three arms
    const inSpine = x >= left && x <= left + stroke && y >= top && y <= bottom;
    const inTop = y >= top && y <= top + stroke && x >= left && x <= right;
    const inMid = y >= mid && y <= mid + stroke && x >= left && x <= right - glyphW * 0.18;
    const inBottom = y >= bottom - stroke && y <= bottom && x >= left && x <= right;
    if (inSpine || inTop || inMid || inBottom) return FG;
    return BG;
  });
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'icon-192.png'), icon(192, false));
writeFileSync(resolve(outDir, 'icon-512.png'), icon(512, false));
writeFileSync(resolve(outDir, 'icon-maskable-512.png'), icon(512, true));
console.log('icons written to', outDir);
