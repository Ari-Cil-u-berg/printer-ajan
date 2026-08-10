// Generates the tray icons and the app icon as plain PNGs — no design tooling or
// binary assets in the repo. Re-run after changing the mark: `node scripts/gen-icons.mjs`.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = [184, 35, 47]; // --brand

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** pixel(x, y, size) -> [r, g, b, a] */
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A receipt printer: body block, paper slot, and a ticket curling out of it. */
function mark(color) {
  return (x, y, size) => {
    const u = x / size;
    const v = y / size;
    const on =
      // printer body
      (u > 0.12 && u < 0.88 && v > 0.42 && v < 0.8) ||
      // paper feeding out of the top
      (u > 0.26 && u < 0.74 && v > 0.16 && v < 0.42);
    if (!on) return [0, 0, 0, 0];
    // slot cut across the body
    const slot = u > 0.22 && u < 0.78 && v > 0.46 && v < 0.53;
    // ruled lines on the paper
    const rule = u > 0.32 && u < 0.68 && (between(v, 0.22, 0.25) || between(v, 0.3, 0.33));
    if (slot || rule) return [255, 255, 255, 255];
    return [...color, 255];
  };
}

const between = (v, a, b) => v > a && v < b;

await mkdir(path.join(root, 'assets'), { recursive: true });
await mkdir(path.join(root, 'build'), { recursive: true });

// Windows/Linux tray: colored. macOS tray: template image (black + alpha, auto-inverted).
await writeFile(path.join(root, 'assets/tray.png'), png(32, mark(BRAND)));
await writeFile(path.join(root, 'assets/trayTemplate.png'), png(32, mark([0, 0, 0])));
await writeFile(path.join(root, 'assets/trayTemplate@2x.png'), png(64, mark([0, 0, 0])));
// electron-builder derives .ico/.icns from this.
await writeFile(path.join(root, 'build/icon.png'), png(512, mark(BRAND)));

console.log('[gen-icons] wrote assets/tray*.png and build/icon.png');
