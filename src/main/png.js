'use strict';
/** 零依赖 PNG 编码器 + 托盘/应用图标绘制（进度环 + 迷你字体百分比） */

const zlib = require('node:zlib');

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
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** RGBA 像素 -> PNG Buffer */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------ 画布工具 */

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = Buffer.alloc(size * size * 4);
  }

  set(x, y, [r, g, b], a = 1) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size || a <= 0) return;
    const i = (y * this.size + x) * 4;
    const dstA = this.data[i + 3] / 255;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) return;
    const mix = (src, dst) => Math.round((src * a + dst * dstA * (1 - a)) / outA);
    this.data[i] = mix(r, this.data[i]);
    this.data[i + 1] = mix(g, this.data[i + 1]);
    this.data[i + 2] = mix(b, this.data[i + 2]);
    this.data[i + 3] = Math.round(outA * 255);
  }

  disc(cx, cy, r, color, alpha = 1) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        const cov = Math.min(1, Math.max(0, r - d + 0.5));
        if (cov > 0) this.set(x, y, color, alpha * cov);
      }
    }
  }

  roundRect(x0, y0, w, h, radius, color, alpha = 1) {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const dx = Math.min(Math.max(x0 + radius - x, 0, x - (x0 + w - 1 - radius)), radius);
        const dy = Math.min(Math.max(y0 + radius - y, 0, y - (y0 + h - 1 - radius)), radius);
        const d = Math.hypot(dx, dy);
        const cov = d <= radius ? 1 : Math.max(0, 1 - (d - radius));
        if (cov > 0) this.set(x, y, color, alpha * cov);
      }
    }
  }

  /** 环形进度：pct 0-100，从 12 点方向顺时针 */
  ring(cx, cy, radius, thickness, pct, color, trackColor, alpha = 1) {
    const p = Math.max(0, Math.min(100, pct)) / 100;
    const outer = radius + thickness / 2;
    const inner = radius - thickness / 2;
    for (let y = Math.floor(cy - outer - 1); y <= Math.ceil(cy + outer + 1); y++) {
      for (let x = Math.floor(cx - outer - 1); x <= Math.ceil(cx + outer + 1); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < inner - 1 || d > outer + 1) continue;
        const cov =
          Math.min(1, Math.max(0, Math.min(d - inner, outer - d) + 0.5));
        if (cov <= 0) continue;
        let ang = Math.atan2(y + 0.5 - cy, x + 0.5 - cx) + Math.PI / 2;
        if (ang < 0) ang += Math.PI * 2;
        const frac = ang / (Math.PI * 2);
        if (p <= 0) this.set(x, y, trackColor, alpha * cov);
        else if (frac <= p) this.set(x, y, color, alpha * cov);
        else this.set(x, y, trackColor, alpha * cov);
      }
    }
  }
}

/* ----------------------------------------------------------- 迷你字体 */
// 3x5 点阵，用于在托盘图标中心画百分比数字
const FONT = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
  '!': ['010', '010', '010', '000', '010'],
};

function drawText(canvas, str, cx, cy, scale, color, alpha = 1) {
  const glyphs = [...str].filter((ch) => FONT[ch]);
  if (!glyphs.length) return;
  const w = 3 * scale;
  const gap = scale;
  const totalW = glyphs.length * w + (glyphs.length - 1) * gap;
  let x0 = Math.round(cx - totalW / 2);
  const y0 = Math.round(cy - (5 * scale) / 2);
  for (const ch of glyphs) {
    const rows = FONT[ch];
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (rows[r][c] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            canvas.set(x0 + c * scale + sx, y0 + r * scale + sy, color, alpha);
          }
        }
      }
    }
    x0 += w + gap;
  }
}

const hex = (h) => {
  const s = String(h || '#22d3ee').replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
};

/** 使用率配色：绿 / 黄 / 橙 / 红 */
function usageColor(pct) {
  if (pct >= 95) return '#ef4444';
  if (pct >= 85) return '#f97316';
  if (pct >= 70) return '#eab308';
  return '#22c55e';
}

function renderTrayIcon({ pct = 0, color, size = 32, showText = true }) {
  const c = new Canvas(size);
  const col = hex(color || usageColor(pct));
  const s = size / 32;
  c.ring(size / 2, size / 2, 11 * s, 5 * s, pct, col, [90, 96, 110], 1);
  if (showText) {
    const label = pct >= 100 ? '!' : String(Math.round(pct)).slice(0, 3);
    drawText(c, label, size / 2, size / 2 + 0.5, Math.max(1, Math.round(s * 1.6)), [235, 240, 250], 1);
  }
  return encodePng(size, size, c.data);
}

function renderAppIcon(size = 256) {
  const c = new Canvas(size);
  const s = size / 256;
  c.roundRect(0, 0, size, size, Math.round(56 * s), [11, 15, 25], 1);
  c.ring(size / 2, size / 2, 78 * s, 26 * s, 72, hex('#22d3ee'), [38, 45, 62], 1);
  c.ring(size / 2, size / 2 - 0, 78 * s, 26 * s, 72, hex('#22d3ee'), [38, 45, 62], 1);
  c.disc(size / 2, size / 2, 40 * s, [11, 15, 25], 1);
  drawText(c, '70', size / 2, size / 2 - 6 * s, Math.round(9 * s), [235, 240, 250], 1);
  drawText(c, 'CC', size / 2, size / 2 + 34 * s, Math.round(5 * s), hex('#22d3ee'), 1);
  return encodePng(size, size, c.data);
}

module.exports = { encodePng, Canvas, drawText, usageColor, renderTrayIcon, renderAppIcon, hex };
