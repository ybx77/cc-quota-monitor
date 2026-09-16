/**
 * png-io.mjs —— 零依赖 PNG 解码 / 缩放（供图标生成使用）
 * 支持 colorType 0/2/3/4/6、bitDepth 1/2/4/8（非隔行），输出 RGBA
 */
import zlib from 'node:zlib';

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

/** 读 PNG → { width, height, rgba: Buffer } */
export function decodePng(buffer) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buffer[i] !== sig[i]) throw new Error('不是有效的 PNG 文件');

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  while (off + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    const type = buffer.toString('ascii', off + 4, off + 8);
    const data = buffer.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (interlace) throw new Error('暂不支持隔行(interlaced) PNG，请用普通 PNG 重新导出');
  if (![1, 2, 4, 8].includes(bitDepth)) throw new Error(`暂不支持 bitDepth=${bitDepth}，请用 8 位 PNG`);

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType=${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const bytesPerLine = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const lines = Buffer.alloc(height * bytesPerLine);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + bytesPerLine);
    p += bytesPerLine;
    const cur = lines.subarray(y * bytesPerLine, (y + 1) * bytesPerLine);
    const prev = y > 0 ? lines.subarray((y - 1) * bytesPerLine, y * bytesPerLine) : null;
    for (let x = 0; x < bytesPerLine; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }

  // 采样函数：返回 0-255 的通道值
  const readSample = (line, index) => {
    if (bitDepth === 8) return line[index];
    const perByte = 8 / bitDepth;
    const byte = line[Math.floor(index / perByte)];
    const shift = 8 - bitDepth * ((index % perByte) + 1);
    const mask = (1 << bitDepth) - 1;
    return ((byte >> shift) & mask) * (255 / mask);
  };

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = lines.subarray(y * bytesPerLine, (y + 1) * bytesPerLine);
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 0) {
        r = g = b = readSample(line, x);
      } else if (colorType === 4) {
        r = g = b = readSample(line, x * 2);
        a = readSample(line, x * 2 + 1);
      } else if (colorType === 2) {
        r = readSample(line, x * 3);
        g = readSample(line, x * 3 + 1);
        b = readSample(line, x * 3 + 2);
      } else if (colorType === 6) {
        r = readSample(line, x * 4);
        g = readSample(line, x * 4 + 1);
        b = readSample(line, x * 4 + 2);
        a = readSample(line, x * 4 + 3);
      } else if (colorType === 3) {
        const idx = readSample(line, x);
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        if (transparency && idx < transparency.length) a = transparency[idx];
      }
      const o = (y * width + x) * 4;
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
      rgba[o + 3] = a;
    }
  }
  return { width, height, rgba };
}

/** 面积平均缩放（放大时退化为双线性采样） */
export function resizeRgba(src, srcW, srcH, dstW, dstH) {
  const out = Buffer.alloc(dstW * dstH * 4);
  const scaleX = srcW / dstW;
  const scaleY = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const y0 = y * scaleY;
    const y1 = Math.min(srcH, Math.max(y0 + 1, (y + 1) * scaleY));
    for (let x = 0; x < dstW; x++) {
      const x0 = x * scaleX;
      const x1 = Math.min(srcW, Math.max(x0 + 1, (x + 1) * scaleX));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const cx = Math.min(srcW - 1, Math.max(0, sx));
          const cy = Math.min(srcH - 1, Math.max(0, sy));
          const o = (cy * srcW + cx) * 4;
          const alpha = src[o + 3] / 255;
          r += src[o] * alpha;
          g += src[o + 1] * alpha;
          b += src[o + 2] * alpha;
          a += src[o + 3];
          n++;
        }
      }
      const o = (y * dstW + x) * 4;
      const avgA = a / n;
      const wsum = avgA > 0 ? n * (avgA / 255) : 1;
      out[o] = Math.min(255, Math.round(r / wsum));
      out[o + 1] = Math.min(255, Math.round(g / wsum));
      out[o + 2] = Math.min(255, Math.round(b / wsum));
      out[o + 3] = Math.round(avgA);
    }
  }
  return out;
}

/** 把任意尺寸图片"contain"到方形画布（保持比例，居中，透明填充） */
export function fitToSquare(src, srcW, srcH, size, { padding = 0.06, background = null } = {}) {
  const inner = Math.round(size * (1 - padding * 2));
  const scale = Math.min(inner / srcW, inner / srcH);
  const w = Math.max(1, Math.round(srcW * scale));
  const h = Math.max(1, Math.round(srcH * scale));
  const scaled = resizeRgba(src, srcW, srcH, w, h);
  const out = Buffer.alloc(size * size * 4);
  if (background) {
    for (let i = 0; i < size * size; i++) {
      out[i * 4] = background[0];
      out[i * 4 + 1] = background[1];
      out[i * 4 + 2] = background[2];
      out[i * 4 + 3] = background[3] ?? 255;
    }
  }
  const ox = Math.round((size - w) / 2);
  const oy = Math.round((size - h) / 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = ((y + oy) * size + (x + ox)) * 4;
      const a = scaled[s + 3] / 255;
      const da = out[d + 3] / 255;
      const oa = a + da * (1 - a);
      if (oa <= 0) continue;
      out[d] = Math.round((scaled[s] * a + out[d] * da * (1 - a)) / oa);
      out[d + 1] = Math.round((scaled[s + 1] * a + out[d + 1] * da * (1 - a)) / oa);
      out[d + 2] = Math.round((scaled[s + 2] * a + out[d + 2] * da * (1 - a)) / oa);
      out[d + 3] = Math.round(oa * 255);
    }
  }
  return out;
}

/** 多尺寸 PNG 打包成 .ico（Windows Vista+ 支持 PNG 载荷） */
export function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((entry, i) => {
    const o = i * 16;
    dir[o] = entry.size >= 256 ? 0 : entry.size;
    dir[o + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(entry.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

export { crc32 };
