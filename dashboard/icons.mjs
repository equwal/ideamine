// The icons of the dashboard for a phone: a lamp on the dark of the board. `node dashboard/icons.mjs`
// writes them again. They are in the repository, so the server needs no drawing program.
//
// The drawing is plain arithmetic on a pixel buffer, at four times the size, and then averaged
// down. That gives smooth edges without a graphics library.

import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const BG = [11, 11, 11]; // --bg of the dark theme
const LAMP = [57, 135, 229]; // --accent
const BASE = [195, 194, 183]; // --text-dim
const SUPER = 4;

const mix = (under, over, alpha) => under.map((c, i) => Math.round(c * (1 - alpha) + over[i] * alpha));

/** A rounded square that holds the whole icon, or the full square for a maskable icon. */
function inTile(x, y, size, radius) {
  const near = (v, edge) => Math.min(v, edge - 1 - v);
  const dx = near(x, size);
  const dy = near(y, size);
  if (dx >= radius || dy >= radius) return true;
  return (radius - dx) ** 2 + (radius - dy) ** 2 <= radius ** 2;
}

const inCircle = (x, y, cx, cy, r) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Distance from the point to the line piece a→b, for the filament of the lamp. */
function distToSegment(x, y, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const len = vx * vx + vy * vy;
  const t = len ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / len)) : 0;
  return Math.hypot(x - (ax + t * vx), y - (ay + t * vy));
}

/** One pixel of the icon: the tile, the glow, the lamp, its filament, and the screw base. */
function pixel(x, y, size, maskable) {
  if (!inTile(x, y, size, maskable ? 0 : size * 0.1875)) return null; // outside the rounded square
  const cx = size / 2;
  const cy = size * 0.44;
  const r = size * (maskable ? 0.17 : 0.21);
  let color = BG;
  const glow = Math.hypot(x - cx, y - cy) / (r * 2.1);
  if (glow < 1) color = mix(color, LAMP, 0.45 * (1 - glow) ** 2);
  const base = [
    [cy + r * 1.02, r * 0.24],
    [cy + r * 1.42, r * 0.24],
    [cy + r * 1.82, r * 0.24],
  ];
  for (const [top, height] of base) {
    if (y >= top && y <= top + height && Math.abs(x - cx) <= r * 0.45) color = BASE;
  }
  if (inCircle(x, y, cx, cy, r)) {
    color = LAMP;
    const wire = r * 0.09;
    const points = [
      [cx - r * 0.42, cy + r * 0.15],
      [cx - r * 0.14, cy - r * 0.35],
      [cx + r * 0.14, cy + r * 0.15],
      [cx + r * 0.42, cy - r * 0.35],
    ];
    for (let i = 0; i < points.length - 1; i++) {
      if (distToSegment(x, y, ...points[i], ...points[i + 1]) <= wire) color = BG;
    }
  }
  return color;
}

/** The pixels of one icon, averaged down from four times the size. */
function draw(size, maskable) {
  const big = size * SUPER;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPER; sy++) {
        for (let sx = 0; sx < SUPER; sx++) {
          const color = pixel(x * SUPER + sx + 0.5, y * SUPER + sy + 0.5, big, maskable);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          a += 255;
        }
      }
      const n = SUPER * SUPER;
      const i = (y * size + x) * 4;
      const solid = a / 255 || 1;
      out[i] = Math.round(r / solid);
      out[i + 1] = Math.round(g / solid);
      out[i + 2] = Math.round(b / solid);
      out[i + 3] = Math.round(a / n);
    }
  }
  return out;
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An RGBA pixel buffer as a PNG file. */
export function png(pixels, size) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head[8] = 8; // bits for each channel
  head[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rows[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const icon = (size, { maskable = false } = {}) => png(draw(size, maskable), size);

export const ICONS = [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, {}],
];

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  for (const [name, size, opts] of ICONS) {
    const file = path.join(DIR, name);
    fs.writeFileSync(file, icon(size, opts));
    console.log(`${name}  ${size}x${size}  ${fs.statSync(file).size} bytes`);
  }
}
