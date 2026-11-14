import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tag = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])), 0);
  return Buffer.concat([len, tag, data, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (width * 4 + 1);
    raw[rowOff] = 0;
    rgba.copy(raw, rowOff + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

function roundedRectDist(x, y, cx, cy, hw, hh, r) {
  const dx = Math.max(Math.abs(x - cx) - (hw - r), 0);
  const dy = Math.max(Math.abs(y - cy) - (hh - r), 0);
  return Math.hypot(dx, dy) - r;
}

function samplePixel(nx, ny) {
  // Background rounded tile (#4f46e5 -> #0ea5e9)
  const tile = roundedRectDist(nx, ny, 0.5, 0.5, 0.44, 0.44, 0.14);
  if (tile > 0.008) return [0, 0, 0, 0];
  const tileAlpha = tile < -0.006 ? 1 : Math.max(0, Math.min(1, (0.008 - tile) / 0.014));

  const t = Math.max(0, Math.min(1, (nx * 0.65 + ny * 0.35)));
  let r = Math.round(79 + (14 - 79) * t);
  let g = Math.round(70 + (165 - 70) * t);
  let b = Math.round(229 + (233 - 229) * t);

  // Subtle top highlight border
  const inner = roundedRectDist(nx, ny, 0.5, 0.5, 0.425, 0.425, 0.125);
  if (inner > 0 && ny < 0.65) {
    r = Math.min(255, r + 35);
    g = Math.min(255, g + 35);
    b = Math.min(255, b + 35);
  }

  // Bot head outline / visor shape in crisp white
  const visor = roundedRectDist(nx, ny, 0.5, 0.53, 0.24, 0.17, 0.08);
  const antennaStem = roundedRectDist(nx, ny, 0.5, 0.29, 0.024, 0.065, 0.012);
  const antennaDot = Math.hypot(nx - 0.5, ny - 0.215) - 0.042;
  const botFg = Math.min(visor, antennaStem, antennaDot);

  if (botFg < 0.006) {
    const fgBlend = botFg < -0.006 ? 1 : (0.006 - botFg) / 0.012;
    r = Math.round(r * (1 - fgBlend) + 248 * fgBlend);
    g = Math.round(g * (1 - fgBlend) + 250 * fgBlend);
    b = Math.round(b * (1 - fgBlend) + 252 * fgBlend);
  }

  // Visor inner screen + three multi-engine color nodes inside bot visor
  const screen = roundedRectDist(nx, ny, 0.5, 0.53, 0.19, 0.12, 0.055);
  if (screen < 0.004) {
    const scBlend = screen < -0.004 ? 1 : (0.004 - screen) / 0.008;
    r = Math.round(r * (1 - scBlend) + 17 * scBlend);
    g = Math.round(g * (1 - scBlend) + 22 * scBlend);
    b = Math.round(b * (1 - scBlend) + 38 * scBlend);

    const dots = [
      [0.39, 0.53, [233, 162, 59]],  // Claude amber
      [0.50, 0.53, [62, 207, 142]],  // Codex emerald
      [0.61, 0.53, [91, 157, 255]],  // Antigravity sky
    ];
    for (const [dx, dy, col] of dots) {
      const dist = Math.hypot(nx - dx, ny - dy) - 0.038;
      if (dist < 0.005) {
        const db = dist < -0.005 ? 1 : (0.005 - dist) / 0.01;
        r = Math.round(r * (1 - db) + col[0] * db);
        g = Math.round(g * (1 - db) + col[1] * db);
        b = Math.round(b * (1 - db) + col[2] * db);
      }
    }
  }

  return [r, g, b, Math.round(tileAlpha * 255)];
}

function renderRgba(size) {
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (const oy of [0.25, 0.75]) {
        for (const ox of [0.25, 0.75]) {
          const [r, g, b, a] = samplePixel((x + ox) / size, (y + oy) / size);
          sr += r; sg += g; sb += b; sa += a;
        }
      }
      const idx = (y * size + x) * 4;
      out[idx] = Math.round(sr / 4);
      out[idx + 1] = Math.round(sg / 4);
      out[idx + 2] = Math.round(sb / 4);
      out[idx + 3] = Math.round(sa / 4);
    }
  }
  return out;
}

const outDir = path.resolve(process.cwd(), 'build');
fs.mkdirSync(outDir, { recursive: true });

const sizes = [16, 32, 48, 256];
const pngs = sizes.map((s) => ({ size: s, data: encodePng(s, s, renderRgba(s)) }));
fs.writeFileSync(path.join(outDir, 'icon.png'), pngs[pngs.length - 1].data);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // ICON
header.writeUInt16LE(pngs.length, 4);

const dirSize = 16 * pngs.length;
let offset = 6 + dirSize;
const entries = [];
for (const entry of pngs) {
  const d = Buffer.alloc(16);
  d[0] = entry.size === 256 ? 0 : entry.size;
  d[1] = entry.size === 256 ? 0 : entry.size;
  d[2] = 0;
  d[3] = 0;
  d.writeUInt16LE(1, 4);
  d.writeUInt16LE(32, 6);
  d.writeUInt32LE(entry.data.length, 8);
  d.writeUInt32LE(offset, 12);
  entries.push(d);
  offset += entry.data.length;
}

fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]));
console.log('GENERATED_ICON_OK', path.join(outDir, 'icon.ico'));
