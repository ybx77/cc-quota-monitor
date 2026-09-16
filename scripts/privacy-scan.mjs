/**
 * 隐私扫描：在待发布的仓库文件里查找个人标识（含二进制文件）
 *   node scripts/privacy-scan.mjs [extraDir]
 * 退出码非 0 表示发现命中，可用于 GitHub Actions / pre-commit。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 默认扫描模式：真实账号 / 本机路径 / 密钥前缀 / 联系方式 */
const PATTERNS = [
  { name: '本机用户名路径', re: /[A-Za-z]:\\Users\\(?!<|USER|your)[A-Za-z0-9._-]+/g },
  { name: 'macOS/Linux 家目录', re: /\/(?:Users|home)\/(?!<|user>|your)[A-Za-z0-9._-]+\//g },
  { name: 'API Key 明文', re: /user_[A-Za-z0-9]{30,}/g },
  { name: 'SL/Stripe 订阅ID', re: /sub_[A-Za-z0-9]{16,}/g },
  { name: 'UUID（可能是用户ID）', re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi },
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
];

const ALLOW_EMAIL = [/@example\.com$/i, /@users\.noreply\.github\.com$/i, /noreply@/i];
const ALLOW_UUID = ['00000000-0000-0000-0000-000000000000'];
const ALLOW_PATH_SEG = ['<', 'USER', 'your', 'runner', 'RunnerAdmin', 'vscode'];
/** 明显是占位符的 API Key（文档 / 测试用）不算泄露 */
const ALLOW_KEY = [/EXAMPLE/i, /DEMO/i, /XXXX/i, /PLACEHOLDER/i, /YOUR_?KEY/i, /1234567890/];

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'out']);
const SKIP_EXT = new Set(['.log', '.zip', '.exe', '.dll', '.node', '.pending']);

const extra = process.argv[2] ? [path.resolve(process.argv[2])] : [];

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), acc);
    } else if (entry.isFile()) {
      if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

const roots = [ROOT, ...extra];
let files = [];
for (const r of roots) {
  if (!fs.existsSync(r)) continue;
  files = files.concat(fs.statSync(r).isDirectory() ? walk(r) : [r]);
}

let hits = 0;
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let text;
  try {
    text = fs.readFileSync(file).toString('latin1');
  } catch {
    continue;
  }
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const value = m[0];
      if (name === '邮箱地址' && ALLOW_EMAIL.some((a) => a.test(value))) continue;
      if (name.startsWith('UUID') && ALLOW_UUID.includes(value.toLowerCase())) continue;
      if (name.includes('路径') && ALLOW_PATH_SEG.some((s) => value.includes(s))) continue;
      if (name === 'API Key 明文' && ALLOW_KEY.some((a) => a.test(value))) continue;
      hits++;
      console.log(`✗ ${rel}: ${name} → ${value}`);
    }
  }
}

console.log(`\n扫描 ${files.length} 个文件，命中 ${hits} 处${hits ? '（请清理后再发布）' : '，未发现个人标识 ✅'}`);
if (hits) process.exitCode = 1;
