/**
 * make-icons.mjs —— 生成应用图标（窗口 / 任务栏 / 打包 / README）
 *
 *   node scripts/make-icons.mjs
 *
 * 图标来源优先级：
 *   1) assets/logo.png            ← 放你自己的 logo 在这里（推荐，正方形或透明底 PNG）
 *   2) assets/icon.png
 *   3) 项目根目录 logo.png
 *   4) 都没有 → 使用内置的进度环图形（无外部依赖）
 *
 * 产物：
 *   build/icon.png        256×256   窗口 / Linux 图标
 *   build/icon-512.png    512×512   商店 / macOS 图标
 *   build/icon.ico        16~256     Windows 打包（electron-builder）
 *   build/icon-32.png     32×32      托盘 / 任务栏小图标
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { decodePng, fitToSquare, buildIco } from './png-io.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { renderAppIcon, encodePng, renderTrayIcon, usageColor } = require('../src/main/png.js');

const outDir = path.join(ROOT, 'build');
fs.mkdirSync(outDir, { recursive: true });

const CANDIDATES = [
  'assets/logo.png',
  'assets/icon.png',
  'assets/logo-512.png',
  'logo.png',
  'icon.png',
];

function findLogo() {
  for (const rel of CANDIDATES) {
    const file = path.join(ROOT, rel);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function write(file, buf) {
  fs.writeFileSync(file, buf);
  console.log(`  ${path.relative(ROOT, file).padEnd(28)} ${(buf.length / 1024).toFixed(1)} KB`);
}

const logo = findLogo();
let decoded = null;
let size256;
let size512;
let size32;
let source;

if (logo) {
  decoded = decodePng(fs.readFileSync(logo));
  console.log(`使用自定义 logo: ${path.relative(ROOT, logo)}  (${decoded.width}×${decoded.height})`);
  const square = (size, padding) => fitToSquare(decoded.rgba, decoded.width, decoded.height, size, { padding });
  size512 = square(512, 0.06);
  size256 = square(256, 0.06);
  size32 = square(32, 0.02);
  source = `${path.relative(ROOT, logo)} (${decoded.width}x${decoded.height})`;
} else {
  console.log('未找到自定义 logo（assets/logo.png），使用内置图形');
  size512 = decodePng(renderAppIcon(512)).rgba;
  size256 = decodePng(renderAppIcon(256)).rgba;
  size32 = decodePng(renderTrayIcon({ pct: 100, color: usageColor(0), size: 32 })).rgba;
  source = 'builtin';
}

const png256 = encodePng(256, 256, size256);
const png512 = encodePng(512, 512, size512);
write(path.join(outDir, 'icon.png'), png256);
write(path.join(outDir, 'icon-512.png'), png512);
write(path.join(outDir, 'icon-32.png'), encodePng(32, 32, size32));

const icoSizes = [16, 32, 48, 64, 128, 256];
const icoEntries = icoSizes.map((size) => {
  const rgba = decoded
    ? fitToSquare(decoded.rgba, decoded.width, decoded.height, size, { padding: size <= 32 ? 0.02 : 0.06 })
    : decodePng(renderAppIcon(size)).rgba;
  return { size, png: encodePng(size, size, rgba) };
});
write(path.join(outDir, 'icon.ico'), buildIco(icoEntries));

// 托盘图标是运行时动态绘制的（进度环 + 剩余百分比），这里只输出预览
fs.mkdirSync(path.join(outDir, 'tray-preview'), { recursive: true });
for (const pct of [100, 68, 40, 12]) {
  write(
    path.join(outDir, 'tray-preview', `tray-${pct}.png`),
    renderTrayIcon({ pct, color: usageColor(100 - pct), size: 32 })
  );
}

fs.writeFileSync(
  path.join(outDir, 'icon-source.json'),
  JSON.stringify({ source, generatedAt: new Date().toISOString(), sizes: [16, 32, 48, 64, 128, 256, 512] }, null, 2)
);
console.log('图标已生成到 build/');
