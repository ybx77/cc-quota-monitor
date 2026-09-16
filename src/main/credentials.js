'use strict';
/**
 * 凭据读取：
 *  1) 自动模式：直接复用 Command Code CLI 的登录态 ~/.commandcode/auth.json
 *  2) 手动模式：使用设置里填写的 API Key
 * 支持文件监听，CLI 重新登录后自动生效。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function authFilePath() {
  const home = process.env.COMMANDCODE_HOME || os.homedir();
  return path.join(home, '.commandcode', 'auth.json');
}

function readCliAuth() {
  const file = authFilePath();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    if (!json.apiKey) return { ok: false, file, error: 'auth.json 中没有 apiKey 字段' };
    return {
      ok: true,
      file,
      apiKey: json.apiKey,
      userId: json.userId ?? null,
      userName: json.userName ?? null,
      keyName: json.keyName ?? null,
      authenticatedAt: json.authenticatedAt ?? null,
      mtimeMs: fs.statSync(file).mtimeMs,
    };
  } catch (err) {
    return { ok: false, file, error: err.code === 'ENOENT' ? '未找到 auth.json，请先运行 cmd 登录' : err.message };
  }
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 14) return `${s.slice(0, 4)}****`;
  return `${s.slice(0, 10)}…${s.slice(-6)}`;
}

/**
 * 解析当前生效的凭据。
 * @param {{credentialsMode?: string, manualApiKey?: string}} settings
 */
function resolveCredentials(settings = {}) {
  const mode = settings.credentialsMode === 'manual' ? 'manual' : 'auto';
  if (mode === 'manual') {
    const key = (settings.manualApiKey || '').trim();
    if (!key) return { ok: false, mode, source: '手动 API Key', error: '尚未填写 API Key' };
    return { ok: true, mode, source: '手动 API Key', apiKey: key, masked: maskKey(key) };
  }
  const cli = readCliAuth();
  if (!cli.ok) return { ok: false, mode, source: 'CLI 登录态', error: cli.error, file: cli.file };
  return {
    ok: true,
    mode,
    source: `CLI 登录态 (${cli.file})`,
    file: cli.file,
    apiKey: cli.apiKey,
    masked: maskKey(cli.apiKey),
    userId: cli.userId,
    userName: cli.userName,
    keyName: cli.keyName,
    authenticatedAt: cli.authenticatedAt,
  };
}

/** 监听 auth.json 变化 */
function watchCliAuth(onChange) {
  const file = authFilePath();
  let watcher = null;
  const start = () => {
    try {
      watcher = fs.watch(path.dirname(file), (event, name) => {
        if (!name || String(name).toLowerCase() === 'auth.json') onChange();
      });
      watcher.on('error', () => {});
    } catch {
      /* 目录不存在时忽略 */
    }
  };
  start();
  return () => {
    try {
      watcher?.close();
    } catch {}
  };
}

module.exports = { authFilePath, readCliAuth, resolveCredentials, maskKey, watchCliAuth };
