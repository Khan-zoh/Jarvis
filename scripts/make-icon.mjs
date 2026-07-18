// Generates packages/app/assets/icon.png (256x256, RGBA) — the high-res source electron-builder
// derives the NSIS installer + app .ico from. Pure Node (zlib only): draws a dark rounded tile
// with a serif "J", so the build has no rasterizer/browser/GPU dependency. Run: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const S = 256;
const BG = [0x0a, 0x0a, 0x0a, 0xff]; // #0a0a0a
const FG = [0xfa, 0xfa, 0xf7, 0xff]; // #fafaf7
const CORNER = 40; // rounded-rect radius

const px = Buffer.alloc(S * S * 4);
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = c[3];
};
const inRoundedTile = (x, y) => {
  // rounded-rect mask so the corners are transparent
  const r = CORNER;
  const cx = x < r ? r : x > S - 1 - r ? S - 1 - r : x;
  const cy = y < r ? r : y > S - 1 - r ? S - 1 - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

// Fill the tile.
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    set(x, y, inRoundedTile(x, y) ? BG : [0, 0, 0, 0]);
  }
}

// Draw a serif "J": vertical stem, top cap bar with a small right serif, and a bottom hook.
const rect = (x0, y0, x1, y1, c) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
};
// stem (right-of-centre so the glyph reads as J, not T)
rect(158, 58, 190, 192, FG);
// top cap bar (serif), biased right over the stem
rect(120, 58, 208, 84, FG);
// small serif feet on the cap ends
rect(120, 58, 132, 94, FG);
rect(196, 58, 208, 94, FG);
// bottom hook: bottom-left quarter-annulus curling left from the stem foot, connected
const hookCx = 174;
const hookCy = 150;
const rOuter = 72;
const rInner = 40;
for (let y = hookCy; y <= hookCy + rOuter; y++) {
  for (let x = hookCx - rOuter; x <= hookCx; x++) {
    const dx = x - hookCx; // <= 0 (left half)
    const dy = y - hookCy; // >= 0 (bottom half)
    const d2 = dx * dx + dy * dy;
    if (d2 <= rOuter * rOuter && d2 >= rInner * rInner) set(x, y, FG);
  }
}

// --- PNG encode (color type 6, 8-bit RGBA, no interlace) ---
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;
// raw scanlines with filter byte 0
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = deflateSync(raw, { level: 9 });
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'packages', 'app', 'assets', 'icon.png');
writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes', `${S}x${S}`);
