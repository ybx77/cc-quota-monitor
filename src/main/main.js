'use strict';
/**
 * Command Code 额度监控 —— Electron 主进程
 * 窗口：主面板 (dashboard) + 桌面悬浮窗 (widget)，托盘常驻。
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  shell,
  screen,
  nativeImage,
  clipboard,
  globalShortcut,
  powerMonitor,
  dialog,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const { CommandCodeClient, normalizeSnapshot } = require('./api');
const { Store } = require('./store');
const { resolveCredentials, watchCliAuth, maskKey, authFilePath } = require('./credentials');
const pricing = require('./pricing');
const { renderTrayIcon, renderAppIcon, usageColor } = require('./png');
const demo = require('./demo');

const APP_NAME = 'Command Code 额度监控';
const STUDIO_USAGE_PATH = 'settings/usage';
/** 演示模式：使用合成数据 + 独立数据目录，不读取真实登录态 */
const DEMO = process.argv.includes('--demo');

let store = null;
let dashboardWin = null;
let widgetWin = null;
let tray = null;
let pricingRaw = null;
let snapshot = null;
let derived = null;
let nextRefreshAt = null;
let refreshing = false;
let lastError = null;
let pollTimer = null;
let tickTimer = null;
let widgetMovedTimer = null;
let notified = new Map(); // key: `${windowKey}:${resetAt}:${level}` -> true
let logLines = [];
let unwatchAuth = null;
const consoleErrors = [];

/** 收集渲染进程控制台错误（用于 --verify 自检） */
function watchConsole(win, tag) {
  if (!win) return;
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || /error|failed|uncaught/i.test(message)) {
      consoleErrors.push({ tag, level, message: String(message).slice(0, 400), source: `${sourceId}:${line}` });
    }
  });
  win.webContents.on('preload-error', (_e, file, err) => consoleErrors.push({ tag, level: 3, message: `preload ${file}: ${err.message}` }));
  win.webContents.on('render-process-gone', (_e, details) => consoleErrors.push({ tag, level: 3, message: `render process gone: ${details.reason}` }));
}

/* ------------------------------------------------------------------ 工具 */

function log(level, msg) {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 500) logLines = logLines.slice(-400);
  try {
    store?.log(level, msg);
  } catch {}
}

function settings() {
  return store.getSettings();
}

function credentials() {
  if (DEMO) {
    return { ok: true, mode: 'demo', source: '演示模式（合成数据，不含真实账号）', masked: 'demo-only', userName: 'demo-user' };
  }
  return resolveCredentials(settings());
}

function makeClient() {
  const s = settings();
  const cred = credentials();
  if (!cred.ok) throw new Error(cred.error);
  return new CommandCodeClient({
    baseUrl: s.apiBaseUrl,
    apiKey: cred.apiKey,
    timeout: s.requestTimeoutMs,
  });
}

function clampToDisplays(bounds) {
  if (!bounds) return null;
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return (
      bounds.x + bounds.width > wa.x - 40 &&
      bounds.x < wa.x + wa.width + 40 &&
      bounds.y + bounds.height > wa.y - 40 &&
      bounds.y < wa.y + wa.height + 40
    );
  });
  if (visible) return bounds;
  const wa = screen.getPrimaryDisplay().workArea;
  return { width: bounds.width, height: bounds.height, x: wa.x + wa.width - bounds.width - 24, y: wa.y + 24 };
}

/* --------------------------------------------------------------- 派生指标 */

function pushSample(snap) {
  if (!snap?.windows) return;
  store.addSample({
    t: Date.parse(snap.fetchedAt),
    fh: snap.windows.fiveHour.used,
    wk: snap.windows.weekly.used,
    mo: snap.windows.monthly.used,
    fhCap: snap.windows.fiveHour.cap,
    wkCap: snap.windows.weekly.cap,
    moCap: snap.windows.monthly.cap,
    cost: snap.periodUsage?.totalCost ?? null,
    req: snap.periodUsage?.totalCount ?? null,
    tok: snap.periodUsage?.totalTokens ?? null,
    fhReset: snap.windows.fiveHour.resetAt,
    wkReset: snap.windows.weekly.resetAt,
    moReset: snap.windows.monthly.resetAt,
  });
}

/** 基于历史采样计算消耗速率 / 耗尽预测 */
function computeDerived(snap, now = Date.now()) {
  const out = { burn: {}, projection: {}, generatedAt: now };
  if (!snap?.windows) return out;
  const { samples } = store.getHistory(now - 24 * 3600 * 1000);

  const rateFor = (field, resetField, lookbackMs) => {
    const pts = samples.filter((s) => now - s.t <= lookbackMs && s[field] != null);
    if (pts.length < 2) return null;
    // 以重置点切段，避免跨越窗口重置造成负数
    let seg = pts;
    for (let i = pts.length - 1; i > 0; i--) {
      if (pts[i][resetField] !== pts[i - 1][resetField]) {
        seg = pts.slice(i);
        break;
      }
    }
    if (seg.length < 2) return null;
    const first = seg[0];
    const last = seg[seg.length - 1];
    const dUsed = last[field] - first[field];
    const dTime = last.t - first.t;
    if (dTime < 60_000 || dUsed < 0) return null;
    return { usdPerHour: (dUsed / dTime) * 3600_000, spanMs: dTime, points: seg.length };
  };

  const plan = [
    ['fiveHour', 'fh', 'fhReset', 5 * 3600_000],
    ['weekly', 'wk', 'wkReset', 24 * 3600_000],
    ['monthly', 'mo', 'moReset', 24 * 3600_000],
  ];

  for (const [key, field, resetField, lookback] of plan) {
    const w = snap.windows[key];
    const rate = rateFor(field, resetField, lookback);
    out.burn[key] = rate ? { ...rate, usdPerHour: round2(rate.usdPerHour) } : null;
    const proj = {
      remainingUsd: w.remaining,
      resetsInMs: w.resetsInMs,
      resetsAt: w.resetAt,
      exhaustsAt: null,
      exhaustBeforeReset: null,
      neededRateToLast: null,
      dailyBudget: null,
    };
    if (w.resetsInMs && w.resetsInMs > 0) {
      proj.neededRateToLast = round2(w.remaining / (w.resetsInMs / 3600_000));
    }
    if (w.resetAt && w.windowMs) {
      proj.dailyBudget = round2(w.cap / (w.windowMs / 86400000));
    }
    if (rate && rate.usdPerHour > 0.0001) {
      const hoursLeft = w.remaining / rate.usdPerHour;
      proj.exhaustsAt = now + hoursLeft * 3600_000;
      proj.hoursToExhaust = round2(hoursLeft);
      proj.exhaustBeforeReset = Boolean(w.resetsInMs && proj.exhaustsAt < w.resetAt);
    }
    out.projection[key] = proj;
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

/* --------------------------------------------------------------- 价目表 */

function pricingScriptPath() {
  return path.join(__dirname, '..', '..', 'scripts', 'fetch-pricing.mjs');
}

/** 联网重新抓取官方价目表（失败时回退到本地缓存） */
async function updatePricingFromWeb() {
  try {
    const mod = await import(pathToFileURL(pricingScriptPath()).href);
    const summary = await mod.updatePricing();
    pricingRaw = pricing.load();
    log('info', `pricing updated: ${summary.models} models @ ${summary.generatedAt}`);
    return { ok: true, source: 'web', ...summary };
  } catch (err) {
    log('warn', `pricing web update failed: ${err.message}`);
    pricingRaw = pricing.load();
    return { ok: false, source: 'cache', error: err.message, count: pricingRaw?.models?.length ?? 0, generatedAt: pricingRaw?.generatedAt ?? null };
  }
}

async function maybeAutoUpdatePricing() {
  if (!settings().autoUpdatePricing) return;
  const age = pricingRaw?.generatedAt ? Date.now() - Date.parse(pricingRaw.generatedAt) : Infinity;
  if (age < 7 * 86400000) return;
  log('info', 'pricing data older than 7 days -> auto update');
  await updatePricingFromWeb();
  broadcast();
}

/* ------------------------------------------------------------------ 刷新 */

/** 演示模式：把合成数据走一遍真实归一化流程 */
async function demoSnapshot() {
  const now = Date.now();
  const raw = demo.rawPayloads(now);
  await new Promise((r) => setTimeout(r, 180)); // 模拟网络延迟
  return normalizeSnapshot({
    whoami: raw.whoami,
    credits: raw.credits,
    subscription: raw.subscription,
    summary: raw.summary,
    orgId: null,
    latencyMs: 180,
    errors: [],
    now,
  });
}

function buildState() {
  const cred = credentials();
  return {
    snapshot,
    derived,
    meta: {
      appName: APP_NAME,
      version: app.getVersion(),
      refreshing,
      nextRefreshAt,
      lastError,
      intervalSec: currentIntervalSec(),
      credential: cred.ok
        ? { ok: true, source: cred.source, masked: cred.masked, userName: cred.userName, file: cred.file ?? null }
        : { ok: false, source: cred.source, error: cred.error, file: cred.file ?? null },
      demo: DEMO,
      apiBaseUrl: settings().apiBaseUrl,
      hasPricing: Boolean(pricingRaw?.models?.length),
      pricingGeneratedAt: pricingRaw?.generatedAt ?? null,
      // 悬浮窗专用设置：随每次广播即时下发，避免等待轮询
      widgetSettings: settings().widget,
      globalHotkey: settings().globalHotkey,
    },
  };
}

function broadcast(reason = '') {
  const state = buildState();
  for (const win of [dashboardWin, widgetWin]) {
    if (win && !win.isDestroyed()) win.webContents.send('state:update', state);
  }
  if (process.argv.includes('--verify') || process.argv.includes('--smoke')) {
    log('info', `broadcast(${reason}) burn5h=${derived?.burn?.fiveHour?.usdPerHour ?? 'null'} samples=${store?.getHistory(0).samples.length ?? 0}`);
  }
  return state;
}

function currentIntervalSec() {
  const s = settings();
  let sec = s.refreshIntervalSec;
  if (s.smartRefresh && widgetWin && !widgetWin.isDestroyed() && widgetWin.isVisible()) {
    sec = Math.min(sec, s.widgetRefreshIntervalSec);
  }
  // 剩余不足 15% 时自动加速，及时预警
  if (snapshot?.windows) {
    const tightest = Math.min(
      snapshot.windows.fiveHour.remainingPct,
      snapshot.windows.weekly.remainingPct,
      snapshot.windows.monthly.remainingPct
    );
    if (tightest <= 15) sec = Math.min(sec, Math.max(10, Math.floor(sec / 2)));
  }
  return Math.max(10, Math.min(3600, sec));
}

function schedule() {
  clearTimeout(pollTimer);
  if (!settings().autoRefresh) {
    nextRefreshAt = null;
    return;
  }
  const sec = currentIntervalSec();
  nextRefreshAt = Date.now() + sec * 1000;
  pollTimer = setTimeout(() => refresh('scheduled').catch(() => {}), sec * 1000);
}

async function refresh(reason = 'manual') {
  if (refreshing) return { skipped: true };
  refreshing = true;
  broadcast();
  try {
    const snap = DEMO ? await demoSnapshot() : await makeClient().snapshot();
    snapshot = snap;
    lastError = snap.errors?.length
      ? { message: snap.errors[0].friendly ?? snap.errors[0].message, at: Date.now(), partial: true }
      : null;
    derived = computeDerived(snap);
    pushSample(snap);
    evaluateNotifications(snap);
    log('info', `refresh ok (${reason}) remaining 5h=$${snap.windows.fiveHour.remaining} wk=$${snap.windows.weekly.remaining} mo=$${snap.windows.monthly.remaining}`);
    if (snap.errors?.length) log('warn', `partial errors: ${JSON.stringify(snap.errors)}`);
    return { ok: true, snapshot };
  } catch (err) {
    lastError = { message: err.friendly ?? err.message, raw: err.message, at: Date.now(), status: err.status ?? 0 };
    log('error', `refresh failed (${reason}): ${err.message}`);
    return { ok: false, error: lastError };
  } finally {
    refreshing = false;
    updateTray();
    broadcast();
    schedule();
  }
}

/* ------------------------------------------------------------ 通知告警 */

function evaluateNotifications(snap) {
  const th = settings().thresholds;
  const items = [
    ['fiveHour', snap.windows.fiveHour],
    ['weekly', snap.windows.weekly],
    ['monthly', snap.windows.monthly],
  ];
  for (const [key, w] of items) {
    const stamp = `${key}:${w.resetAt ?? 'na'}`;
    if (w.exceeded && th.notifyOnExceeded && !notified.has(`${stamp}:exceeded`)) {
      notified.set(`${stamp}:exceeded`, true);
      notify('额度已用尽', `${w.label}额度已用完（$${w.used} / $${w.cap}），将在 ${fmtDur(w.resetsInMs)} 后重置。`);
    }
    if (w.usedPct >= th.critical && th.notifyOnCritical && !notified.has(`${stamp}:critical`)) {
      notified.set(`${stamp}:critical`, true);
      notify('额度告警 · 严重', `${w.label}额度已使用 ${w.usedPct}%，仅剩 $${w.remaining}。`);
    } else if (w.usedPct >= th.warn && th.notifyOnWarn && !notified.has(`${stamp}:warn`)) {
      notified.set(`${stamp}:warn`, true);
      notify('额度提醒', `${w.label}额度已使用 ${w.usedPct}%，剩余 $${w.remaining}。`);
    }
    // 重置提醒：曾经记录过该窗口，重置点变化说明已重置
    if (th.notifyOnReset && w.resetsInMs != null && w.resetsInMs < 60_000) {
      const rk = `${key}:reset-notice:${w.resetAt}`;
      if (!notified.has(rk)) {
        notified.set(rk, true);
        notify('额度窗口即将重置', `${w.label}额度将在 1 分钟内重置为 $${w.cap}。`);
      }
    }
  }
  if (notified.size > 400) notified = new Map([...notified].slice(-200));
}

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: false, icon: nativeImage.createFromBuffer(renderAppIcon(128)) });
    n.on('click', () => showDashboard());
    n.show();
  } catch (err) {
    log('warn', `notify failed: ${err.message}`);
  }
}

function fmtDur(ms) {
  if (ms == null) return '未知';
  const m = Math.max(1, Math.ceil(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${mm}分`;
  return `${mm}分钟`;
}

/* ------------------------------------------------------------------ 托盘 */

function trayWindow() {
  const key = settings().trayPercentWindow || 'fiveHour';
  return snapshot?.windows?.[key] ?? snapshot?.windows?.fiveHour ?? null;
}

function updateTray() {
  if (!tray) return;
  const w = trayWindow();
  const remainingPct = w ? Math.round(w.remainingPct) : 0;
  const usedPct = w ? w.usedPct : 0;
  try {
    const size = process.platform === 'win32' ? 32 : 22;
    const png = renderTrayIcon({ pct: remainingPct, color: usageColor(usedPct), size });
    tray.setImage(nativeImage.createFromBuffer(png));
  } catch (err) {
    log('warn', `tray icon failed: ${err.message}`);
  }
  const lines = [];
  if (snapshot?.account?.userName) lines.push(`账号: ${snapshot.account.userName}`);
  if (snapshot?.plan?.name) lines.push(`套餐: ${snapshot.plan.name}${snapshot.plan.status ? ` (${snapshot.plan.status})` : ''}`);
  for (const key of ['fiveHour', 'weekly', 'monthly']) {
    const win = snapshot?.windows?.[key];
    if (!win) continue;
    lines.push(`${win.label}: 剩余 $${win.remaining.toFixed(2)} / $${win.cap.toFixed(2)}  (${win.remainingPct.toFixed(1)}%) · ${fmtDur(win.resetsInMs)}后重置`);
  }
  if (snapshot?.derived) {
    const b = derived?.burn?.fiveHour;
    if (b) lines.push(`5h 消耗速率: $${b.usdPerHour.toFixed(3)}/小时`);
  }
  if (lastError) lines.push(`⚠ ${lastError.message}`);
  if (snapshot?.fetchedAt) lines.push(`更新于 ${new Date(snapshot.fetchedAt).toLocaleTimeString()}`);
  tray.setToolTip(lines.join('\n') || APP_NAME);
}

function buildTrayMenu() {
  const s = settings();
  const w = trayWindow();
  const widgetVisible = Boolean(s.widget.enabled && widgetWin && !widgetWin.isDestroyed() && widgetWin.isVisible());
  return Menu.buildFromTemplate([
    { label: `${snapshot?.plan?.name ? `GOAT/套餐: ${snapshot.plan.name}` : APP_NAME}`, enabled: false },
    { label: w ? `${w.label} 剩余 $${w.remaining.toFixed(2)} (${w.remainingPct.toFixed(1)}%)` : '暂无数据', enabled: false },
    { type: 'separator' },
    { label: '打开主面板', click: () => showDashboard() },
    {
      label: '显示悬浮窗',
      type: 'checkbox',
      checked: widgetVisible,
      click: (item) => setWidgetEnabled(item.checked),
    },
    {
      label: '悬浮窗总在最前',
      type: 'checkbox',
      checked: Boolean(s.widget.alwaysOnTop),
      click: (item) => {
        store.saveSettings({ widget: { alwaysOnTop: item.checked } });
        applyWidgetSettings();
      },
    },
    {
      label: '鼠标穿透（开启后悬浮窗不响应点击）',
      type: 'checkbox',
      checked: Boolean(s.widget.clickThrough),
      click: (item) => {
        store.saveSettings({ widget: { clickThrough: item.checked } });
        applyWidgetSettings();
        if (!item.checked) widgetWin?.showInactive();
        broadcast();
      },
    },
    { label: '立即刷新', click: () => refresh('tray') },
    {
      label: '刷新间隔',
      submenu: [15, 30, 60, 120, 300, 600].map((sec) => ({
        label: `${sec >= 60 ? `${sec / 60} 分钟` : `${sec} 秒`}`,
        type: 'radio',
        checked: s.refreshIntervalSec === sec,
        click: () => {
          store.saveSettings({ refreshIntervalSec: sec });
          schedule();
          broadcast();
        },
      })),
    },
    {
      label: '托盘显示',
      submenu: [
        ['fiveHour', '5 小时窗口'],
        ['weekly', '每周窗口'],
        ['monthly', '每月窗口'],
      ].map(([key, label]) => ({
        label,
        type: 'radio',
        checked: s.trayPercentWindow === key,
        click: () => {
          store.saveSettings({ trayPercentWindow: key });
          updateTray();
        },
      })),
    },
    { type: 'separator' },
    { label: '打开网页用量页', click: () => openUsagePage() },
    { label: '打开设置', click: () => showDashboard('settings') },
    { label: '重置悬浮窗位置', click: () => resetWidgetPosition() },
    { type: 'separator' },
    { label: '退出', click: () => quitApp() },
  ]);
}

function resetWidgetPosition() {
  const wa = screen.getPrimaryDisplay().workArea;
  const size = widgetSize();
  const bounds = { width: size.width, height: size.height, x: wa.x + wa.width - size.width - 24, y: wa.y + 40 };
  store.saveSettings({ widget: { bounds, enabled: true } });
  if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.setBounds(bounds);
    widgetWin.showInactive();
  } else {
    setWidgetEnabled(true);
  }
  broadcast();
  return bounds;
}

function createTray() {
  const size = process.platform === 'win32' ? 32 : 22;
  const icon = nativeImage.createFromBuffer(renderTrayIcon({ pct: 0, size }));
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.on('click', () => showDashboard());
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  updateTray();
}

/* ------------------------------------------------------------------ 窗口 */

function iconImage() {
  // 优先使用 build/icon.png（由 scripts/make-icons.mjs 从 assets/logo.png 生成）
  try {
    const file = path.join(__dirname, '..', '..', 'build', 'icon.png');
    if (fs.existsSync(file)) {
      const img = nativeImage.createFromPath(file);
      if (!img.isEmpty()) return img;
    }
  } catch {}
  try {
    return nativeImage.createFromBuffer(renderAppIcon(256));
  } catch {
    return undefined;
  }
}

function createDashboard() {
  if (dashboardWin && !dashboardWin.isDestroyed()) return dashboardWin;
  const s = settings();
  dashboardWin = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: s.theme === 'light' ? '#f6f7fb' : '#0b0f19',
    icon: iconImage(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  dashboardWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  watchConsole(dashboardWin, 'dashboard');
  dashboardWin.once('ready-to-show', () => {
    if (!(process.argv.includes('--hidden') && s.startMinimized)) dashboardWin.show();
  });
  dashboardWin.on('close', (e) => {
    if (!app.isQuitting && settings().closeToTray) {
      e.preventDefault();
      dashboardWin.hide();
    }
  });
  dashboardWin.on('focus', () => {
    if (settings().autoRefresh && snapshot && Date.now() - Date.parse(snapshot.fetchedAt) > 30_000) refresh('focus');
  });
  dashboardWin.on('closed', () => {
    dashboardWin = null;
  });
  return dashboardWin;
}

function showDashboard(tab) {
  const win = createDashboard();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (tab) win.webContents.send('ui:navigate', tab);
}

function widgetBounds() {
  const s = settings();
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const size = widgetSize();
  const saved = clampToDisplays(s.widget.bounds);
  if (saved) return saved;
  return { width: size.width, height: size.height, x: wa.x + wa.width - size.width - 24, y: wa.y + 40 };
}

function widgetSize() {
  const ws = settings().widget;
  const scale = ws.scale || 1;
  const base = ws.compact
    ? ws.orientation === 'horizontal'
      ? { width: 420, height: 96 }
      : { width: 240, height: 132 }
    : ws.orientation === 'horizontal'
      ? { width: 520, height: 132 }
      : { width: 300, height: 236 };
  return { width: Math.round(base.width * scale), height: Math.round(base.height * scale) };
}

function createWidget() {
  if (widgetWin && !widgetWin.isDestroyed()) return widgetWin;
  const s = settings();
  const bounds = widgetBounds();
  widgetWin = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: !s.widget.locked,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    icon: iconImage(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  widgetWin.loadFile(path.join(__dirname, '..', 'renderer', 'widget.html'));
  watchConsole(widgetWin, 'widget');
  widgetWin.setAlwaysOnTop(Boolean(s.widget.alwaysOnTop), 'screen-saver');
  widgetWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  widgetWin.setIgnoreMouseEvents(Boolean(s.widget.clickThrough), { forward: true });
  widgetWin.setOpacity(clampOpacity(s.widget.opacity));
  widgetWin.once('ready-to-show', () => {
    if (s.widget.enabled) widgetWin.showInactive();
  });
  widgetWin.on('moved', () => {
    clearTimeout(widgetMovedTimer);
    widgetMovedTimer = setTimeout(() => {
      if (!widgetWin || widgetWin.isDestroyed()) return;
      let b = widgetWin.getBounds();
      if (settings().widget.snapToEdges) b = snapBounds(b);
      store.saveSettings({ widget: { bounds: b } });
      broadcast();
    }, 350);
  });
  widgetWin.on('closed', () => {
    widgetWin = null;
  });
  return widgetWin;
}

function snapBounds(b) {
  const wa = screen.getDisplayMatching(b).workArea;
  const edge = 16;
  const out = { ...b };
  if (Math.abs(b.x - wa.x) < edge) out.x = wa.x;
  if (Math.abs(b.x + b.width - (wa.x + wa.width)) < edge) out.x = wa.x + wa.width - b.width;
  if (Math.abs(b.y - wa.y) < edge) out.y = wa.y;
  if (Math.abs(b.y + b.height - (wa.y + wa.height)) < edge) out.y = wa.y + wa.height - b.height;
  return out;
}

const clampOpacity = (v) => Math.min(1, Math.max(0.2, Number(v) || 0.94));

/** 开启鼠标穿透时提示退出方式（所有入口共用） */
let lastClickThrough = null;
function announceClickThrough(enabled) {
  if (lastClickThrough === enabled) return;
  lastClickThrough = enabled;
  if (enabled) {
    const key = settings().globalHotkey || 'CommandOrControl+Shift+Q';
    notify('悬浮窗已开启鼠标穿透', `悬浮窗暂时不再响应鼠标。按 ${prettyAccel(key)}，或从托盘右键菜单关闭「鼠标穿透」，即可恢复点击。`);
  }
}

function prettyAccel(accel) {
  return String(accel).replace('CommandOrControl', process.platform === 'win32' ? 'Ctrl' : 'Cmd').replace(/\+/g, ' + ');
}

/** 供"逃生"使用：强制关闭鼠标穿透并把悬浮窗带到最前 */
function releaseWidget({ notifyUser = true } = {}) {
  const s = settings();
  store.saveSettings({ widget: { clickThrough: false, enabled: true } });
  if (!widgetWin || widgetWin.isDestroyed()) setWidgetEnabled(true);
  else applyWidgetSettings();
  widgetWin?.showInactive();
  widgetWin?.setAlwaysOnTop(Boolean(settings().widget.alwaysOnTop), 'screen-saver');
  if (notifyUser) notify('悬浮窗已恢复可点击', '鼠标穿透已关闭，现在可以正常点击悬浮窗上的按钮了。');
  return settings().widget;
}

/** 全局快捷键：在「显示 / 恢复可点击 / 隐藏」之间循环 */
function toggleWidgetByHotkey() {
  const s = settings();
  const visible = Boolean(widgetWin && !widgetWin.isDestroyed() && widgetWin.isVisible());
  if (!s.widget.enabled || !visible) {
    setWidgetEnabled(true);
    return;
  }
  if (s.widget.clickThrough) {
    releaseWidget();
    return;
  }
  setWidgetEnabled(false);
}

function setWidgetEnabled(enabled) {
  store.saveSettings({ widget: { enabled: Boolean(enabled) } });
  if (enabled) {
    const win = createWidget();
    const size = widgetSize();
    const b = clampToDisplays(settings().widget.bounds) ?? win.getBounds();
    win.setBounds({ ...b, width: size.width, height: size.height });
    win.showInactive();
    win.setAlwaysOnTop(Boolean(settings().widget.alwaysOnTop), 'screen-saver');
  } else if (widgetWin && !widgetWin.isDestroyed()) {
    widgetWin.hide();
  }
  updateTray();
  broadcast();
}

function applyWidgetSettings() {
  const s = settings().widget;
  if (!widgetWin || widgetWin.isDestroyed()) {
    if (s.enabled) setWidgetEnabled(true);
    return;
  }
  const size = widgetSize();
  const b = clampToDisplays(s.bounds) ?? widgetWin.getBounds();
  widgetWin.setBounds({ ...b, width: size.width, height: size.height });
  widgetWin.setAlwaysOnTop(Boolean(s.alwaysOnTop), 'screen-saver');
  widgetWin.setIgnoreMouseEvents(Boolean(s.clickThrough), { forward: true });
  announceClickThrough(Boolean(s.clickThrough));
  widgetWin.setOpacity(clampOpacity(s.opacity));
  widgetWin.setMovable(!s.locked);
  if (s.enabled) {
    if (!widgetWin.isVisible()) widgetWin.showInactive();
  } else if (widgetWin.isVisible()) {
    widgetWin.hide();
  }
  updateTray();
  // 立即把最新设置推给悬浮窗（否则要等下一次刷新/轮询）
  broadcast('widget-settings');
}

function quitApp() {
  app.isQuitting = true;
  clearTimeout(pollTimer);
  clearInterval(tickTimer);
  try {
    globalShortcut.unregisterAll();
  } catch {}
  app.quit();
}

function openUsagePage() {
  const user = snapshot?.account?.orgLogin ?? snapshot?.account?.userName ?? '';
  const url = user ? `https://commandcode.ai/${user}/${STUDIO_USAGE_PATH}` : 'https://commandcode.ai/studio';
  shell.openExternal(url);
}

/* ------------------------------------------------------------------- IPC */

function registerIpc() {
  ipcMain.handle('state:get', () => buildState());
  ipcMain.handle('state:refresh', async (_e, reason) => {
    const r = await refresh(reason || 'ipc');
    return { ...buildState(), result: r };
  });
  ipcMain.handle('settings:get', () => settings());
  ipcMain.handle('settings:save', (_e, patch) => {
    const before = JSON.stringify(settings());
    const next = store.saveSettings(patch || {});
    applySideEffects(before, next);
    broadcast();
    return next;
  });
  ipcMain.handle('settings:reset', () => {
    const next = store.resetSettings();
    applySideEffects('', next);
    applyWidgetSettings();
    broadcast();
    return next;
  });
  ipcMain.handle('pricing:get', () => {
    const s = settings();
    const decorated = pricing.decorate(pricingRaw ?? pricing.load(), s.modelTable.profile);
    return { ...decorated, appliedProfile: s.modelTable.profile, file: pricingRaw?.file ?? null };
  });
  ipcMain.handle('pricing:reload', async () => {
    const r = await updatePricingFromWeb();
    broadcast();
    return { ...r, count: pricingRaw?.models?.length ?? 0, generatedAt: pricingRaw?.generatedAt ?? null };
  });
  ipcMain.handle('history:get', (_e, sinceMs) => store.getHistory(sinceMs));
  ipcMain.handle('history:clear', () => {
    store.clearHistory();
    derived = computeDerived(snapshot);
    broadcast();
    return { ok: true };
  });
  ipcMain.handle('diagnostics:get', () => {
    const cred = credentials();
    const projectRoot = path.join(__dirname, '..', '..');
    return {
      state: buildState(),
      raw: snapshot?.raw ?? null,
      log: store.readLog(200),
      credential: { ...cred, apiKey: undefined, file: DEMO ? '<demo>' : cred.file },
      // 演示模式不暴露本机路径（README 截图直接取自这里）
      authFile: DEMO ? '~/.commandcode/auth.json' : authFilePath(),
      userData: DEMO ? '<demo-userdata>' : app.getPath('userData'),
      versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
      pricingFile: pricingRaw?.file ? path.relative(projectRoot, pricingRaw.file).replace(/\\/g, '/') : null,
      pricingGeneratedAt: pricingRaw?.generatedAt ?? null,
    };
  });
  ipcMain.handle('export:data', async (_e, kind) => {
    const dir = app.getPath('documents');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let defaultPath;
    let content;
    if (kind === 'history-csv') {
      defaultPath = path.join(dir, `cc-quota-history-${stamp}.csv`);
      const { samples } = store.getHistory(0);
      const head = 'time,fiveHourUsed,fiveHourCap,weeklyUsed,weeklyCap,monthlyUsed,monthlyCap,periodCost,requests,totalTokens\n';
      content = head + samples.map((s) => [new Date(s.t).toISOString(), s.fh, s.fhCap, s.wk, s.wkCap, s.mo, s.moCap, s.cost, s.req, s.tok].join(',')).join('\n');
    } else if (kind === 'pricing-csv') {
      defaultPath = path.join(dir, `cc-goat-models-${stamp}.csv`);
      const models = pricingRaw?.models ?? [];
      const head = 'name,modelId,context,intelligence,tokPerSec,inputUSD,outputUSD,cacheReadUSD,cacheWriteUSD,perRequestUSD,free\n';
      content =
        head +
        models
          .map((m) =>
            [m.name, m.modelId ?? '', m.context ?? '', m.intelligence ?? '', m.tokensPerSecond ?? '', m.input ?? '', m.output ?? '', m.cacheRead ?? '', m.cacheWrite ?? '', m.perRequest ?? '', m.free ? 'yes' : 'no']
              .map((v) => (typeof v === 'string' && v.includes(',') ? `"${v}"` : v))
              .join(',')
          )
          .join('\n');
    } else {
      defaultPath = path.join(dir, `cc-quota-snapshot-${stamp}.json`);
      content = JSON.stringify({ exportedAt: new Date().toISOString(), state: buildState(), history: store.getHistory(0), pricing: pricingRaw }, null, 2);
    }
    const res = await dialog.showSaveDialog(dashboardWin ?? undefined, { defaultPath });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, file: res.filePath };
  });
  ipcMain.handle('auth:test', async (_e, payload) => {
    try {
      const client = new CommandCodeClient({
        baseUrl: payload?.baseUrl || settings().apiBaseUrl,
        apiKey: payload?.apiKey || credentials().apiKey,
        timeout: settings().requestTimeoutMs,
      });
      const who = await client.whoami();
      const cred = await client.credits(who?.data?.org?.id ?? null).catch(() => null);
      return {
        ok: true,
        user: who?.data?.user ?? null,
        latencyMs: who?.latencyMs ?? null,
        windows: cred?.data?.windowLimits ?? null,
        monthlyRemaining: cred?.data?.credits?.monthlyCredits ?? null,
      };
    } catch (err) {
      return { ok: false, error: err.friendly ?? err.message };
    }
  });
  ipcMain.handle('open:external', (_e, url) => shell.openExternal(String(url)));
  ipcMain.handle('open:usage-page', () => openUsagePage());
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });
  ipcMain.handle('notify:test', () => {
    notify('测试通知', '如果你看到这条消息，说明额度告警通知已经可用。');
    return { ok: true };
  });
  ipcMain.handle('app:quit', () => quitApp());
  ipcMain.handle('app:hide', () => dashboardWin?.hide());
  ipcMain.handle('dashboard:show', (_e, tab) => {
    showDashboard(tab);
    return { ok: true };
  });
  ipcMain.handle('widget:action', (_e, { action, value } = {}) => {
    switch (action) {
      case 'toggle':
        setWidgetEnabled(!(settings().widget.enabled && widgetWin?.isVisible()));
        break;
      case 'show':
        setWidgetEnabled(true);
        break;
      case 'hide':
        setWidgetEnabled(false);
        break;
      case 'pin':
        store.saveSettings({ widget: { alwaysOnTop: value === undefined ? !settings().widget.alwaysOnTop : Boolean(value) } });
        applyWidgetSettings();
        break;
      case 'clickThrough':
        store.saveSettings({ widget: { clickThrough: Boolean(value) } });
        applyWidgetSettings();
        break;
      case 'release':
        releaseWidget();
        break;
      case 'compact':
        store.saveSettings({ widget: { compact: Boolean(value) } });
        applyWidgetSettings();
        break;
      case 'lock':
        store.saveSettings({ widget: { locked: Boolean(value) } });
        applyWidgetSettings();
        break;
      case 'scale':
        store.saveSettings({ widget: { scale: Math.min(2, Math.max(0.7, Number(value) || 1)) } });
        applyWidgetSettings();
        break;
      case 'resize':
        applyWidgetSettings();
        break;
      case 'resetPosition':
        resetWidgetPosition();
        break;
      case 'snap':
        if (widgetWin && !widgetWin.isDestroyed()) widgetWin.setBounds(snapBounds(widgetWin.getBounds()));
        break;
      default:
        break;
    }
    broadcast();
    return settings().widget;
  });
  ipcMain.handle('widget:get-settings', () => settings());
  ipcMain.handle('hotkey:register', () => {
    registerHotkey();
    return { ok: true, hotkey: settings().globalHotkey };
  });
}

function applySideEffects(beforeJson, next) {
  const before = beforeJson ? JSON.parse(beforeJson) : null;
  if (!before || before.theme !== next.theme) {
    dashboardWin?.webContents.send('ui:theme', next.theme);
  }
  if (!before || before.launchAtLogin !== next.launchAtLogin) {
    try {
      app.setLoginItemSettings({ openAtLogin: Boolean(next.launchAtLogin), args: ['--hidden'] });
    } catch (err) {
      log('warn', `setLoginItemSettings failed: ${err.message}`);
    }
  }
  if (!before || before.globalHotkey !== next.globalHotkey) registerHotkey();
  if (!before || before.trayPercentWindow !== next.trayPercentWindow) updateTray();
  if (!before || JSON.stringify(before.widget) !== JSON.stringify(next.widget)) applyWidgetSettings();
  if (!before || before.autoRefresh !== next.autoRefresh || before.refreshIntervalSec !== next.refreshIntervalSec || before.smartRefresh !== next.smartRefresh) schedule();
}

function registerHotkey() {
  try {
    globalShortcut.unregisterAll();
  } catch {}
  const accel = settings().globalHotkey;
  if (!accel) return;
  try {
    const ok = globalShortcut.register(accel, () => toggleWidgetByHotkey());
    if (!ok) log('warn', `hotkey 注册失败: ${accel}`);
    else log('info', `hotkey 注册成功: ${accel}`);
  } catch (err) {
    log('warn', `hotkey error: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ 启动 */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showDashboard());

  app.whenReady().then(async () => {
    app.setAppUserModelId('ai.commandcode.quota-monitor');
    // 演示模式：写到独立的临时目录，绝不触碰真实设置 / 历史 / 登录态
    if (DEMO) app.setPath('userData', path.join(app.getPath('temp'), 'cc-quota-monitor-demo'));
    store = new Store(app.getPath('userData'));
    // 演示模式：每次启动都用同一套合成数据重建历史，保证截图与曲线可复现
    if (DEMO) {
      store.clearHistory();
      for (const s of demo.demoSamples()) store.addSample(s);
      store.getHistory(0);
    }
    pricingRaw = pricing.load();
    log('info', `app start v${app.getVersion()} pricing=${pricingRaw.models?.length ?? 0} models`);

    registerIpc();
    createDashboard();
    createTray();
    if (settings().widget.enabled) setWidgetEnabled(true);
    applySideEffects('', settings());

    unwatchAuth = watchCliAuth(() => {
      log('info', 'auth.json changed -> refresh');
      refresh('auth-changed');
    });

    powerMonitor.on('resume', () => refresh('resume'));
    powerMonitor.on('unlock-screen', () => refresh('unlock'));

    // 价目表超过 7 天时后台自动更新（不阻塞启动）
    maybeAutoUpdatePricing().catch((e) => log('warn', `auto pricing update: ${e.message}`));

    // 每秒心跳：推送倒计时 / 到点刷新
    tickTimer = setInterval(() => {
      for (const win of [dashboardWin, widgetWin]) {
        if (win && !win.isDestroyed()) win.webContents.send('state:tick', { now: Date.now(), nextRefreshAt, refreshing });
      }
      if (nextRefreshAt && Date.now() >= nextRefreshAt && !refreshing && settings().autoRefresh) refresh('scheduled');
    }, 1000);

    const result = await refresh('startup');

    // 无界面自检：--smoke [--smoke-json] 打印一次快照后退出，用于自动化验证
    if (process.argv.includes('--smoke')) {
      const payload = { ok: result.ok, meta: buildState().meta, snapshot, derived };
      console.log('SMOKE_RESULT ' + JSON.stringify(payload, null, 2));
      setTimeout(() => quitApp(), 500);
      return;
    }

    // 截图自检：--shot 渲染各页面并保存 PNG（演示模式下输出到 docs/screenshots，可直接进仓库）
    if (process.argv.includes('--shot')) {
      const dir = DEMO ? path.join(__dirname, '..', '..', 'docs', 'screenshots') : path.join(__dirname, '..', '..', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const capture = async (win, file) => {
        if (!win || win.isDestroyed()) return;
        try {
          win.showInactive();
          await wait(900);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(dir, file), img.toPNG());
          console.log(`SHOT ${file} ${img.getSize().width}x${img.getSize().height}`);
        } catch (err) {
          console.log(`SHOT FAILED ${file}: ${err.message}`);
        }
      };
      await wait(2500);
      for (const tab of ['overview', 'history', 'pricing', 'settings', 'diagnostics']) {
        dashboardWin?.webContents.send('ui:navigate', tab);
        await capture(dashboardWin, `dashboard-${tab}.png`);
      }
      dashboardWin?.webContents.send('ui:navigate', 'overview');
      await capture(widgetWin, 'widget.png');
      store.saveSettings({ widget: { compact: true, orientation: 'horizontal' } });
      applyWidgetSettings();
      await capture(widgetWin, 'widget-compact.png');
      store.saveSettings({ widget: { compact: false, orientation: 'vertical' } });
      applyWidgetSettings();
      console.log('SHOTS_DONE');
      setTimeout(() => quitApp(), 400);
      return;
    }

    // 交互自检：--uitest 逐个点击托盘菜单项与悬浮窗按钮，报告失败项
    if (process.argv.includes('--uitest')) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      // 自检会修改设置，结束后原样还原（避免污染真实配置）
      const settingsBackup = JSON.parse(JSON.stringify(store.getSettings()));
      await wait(2500);

      // 1) 托盘菜单逐项执行
      const trayResults = [];
      const runItem = async (item, trail) => {
        const name = `${trail}${item.label || item.type}`;
        if (item.submenu) {
          for (const sub of item.submenu.items) await runItem(sub, `${name} > `);
          return;
        }
        if (!item.click || /退出/.test(item.label || '')) {
          trayResults.push({ item: name, skipped: true });
          return;
        }
        try {
          await item.click(item);
          await wait(80);
          trayResults.push({ item: name, ok: true });
        } catch (err) {
          trayResults.push({ item: name, ok: false, error: err.message });
        }
      };
      for (const item of buildTrayMenu().items) await runItem(item, '');

      // 端到端：托盘「打开主面板」「打开设置」必须真的把主窗口显示出来
      dashboardWin.hide();
      await buildTrayMenu().items.find((i) => i.label === '打开主面板').click();
      await wait(400);
      trayResults.push({
        item: 'E2E 打开主面板后主窗口可见',
        ok: Boolean(dashboardWin && dashboardWin.isVisible()),
        error: dashboardWin?.isVisible() ? undefined : '主窗口未显示',
      });
      buildTrayMenu().items.find((i) => i.label === '打开设置').click();
      await wait(400);
      trayResults.push({
        item: 'E2E 打开设置后主窗口可见',
        ok: Boolean(dashboardWin && dashboardWin.isVisible()),
        error: dashboardWin?.isVisible() ? undefined : '主窗口未显示',
      });

      // 2) 悬浮窗按钮逐项点击（先确保未开启鼠标穿透）
      store.saveSettings({ widget: { clickThrough: false, enabled: true, alwaysOnTop: true } });
      applyWidgetSettings();
      await wait(400);
      const widgetResults = [];
      const pageClick = (sels) =>
        widgetWin.webContents.executeJavaScript(`(async () => {
        const out = [];
        for (const [sel, label] of ${JSON.stringify(sels)}) {
          const el = document.querySelector(sel);
          if (!el) { out.push({ label, ok: false, error: '元素不存在: ' + sel }); continue; }
          try { el.click(); await new Promise((r) => setTimeout(r, 200)); out.push({ label, ok: true }); }
          catch (e) { out.push({ label, ok: false, error: String((e && e.message) || e) }); }
        }
        return out;
      })()`);
      const expect = (label, cond, error) => widgetResults.push({ label, ok: Boolean(cond), error: cond ? undefined : error });

      // 2a) 标题栏按钮
      widgetResults.push(...(await pageClick([['#b-refresh', '刷新'], ['#b-pin', '置顶'], ['#b-menu', '更多菜单']])));
      await pageClick([['#b-menu', '关闭菜单']]);
      widgetResults.push(...(await pageClick([['#b-open', '打开主面板']])));
      await wait(400);
      expect('E2E 悬浮窗「打开主面板」后主窗口可见', dashboardWin && dashboardWin.isVisible(), '主窗口未显示');

      // 2b) ⋯ 菜单：每个开关单独验证"点击前后是否真的变化"
      const toggleCases = [
        ['top', 'alwaysOnTop', '总在最前'],
        ['click', 'clickThrough', '鼠标穿透'],
        ['compact', 'compact', '紧凑模式'],
        ['lock', 'locked', '锁定位置'],
        ['near', 'snapToEdges', '贴边吸附'],
      ];
      for (const [act, key, label] of toggleCases) {
        const before = settings().widget[key];
        widgetResults.push(...(await pageClick([[`#menu button[data-act="${act}"]`, `菜单:${act}`]])));
        await wait(250);
        const after = settings().widget[key];
        expect(`菜单「${label}」切换生效`, before !== after, `${key} 未变化（仍为 ${before}）`);
        // 复原，避免影响后续断言
        store.saveSettings({ widget: { [key]: before } });
        applyWidgetSettings();
        await wait(120);
      }
      const orientBefore = settings().widget.orientation;
      widgetResults.push(...(await pageClick([['#menu button[data-act="orient"]', '菜单:orient']])));
      await wait(250);
      expect('菜单「横向/纵向」切换生效', settings().widget.orientation !== orientBefore, '方向未变化');
      store.saveSettings({ widget: { orientation: orientBefore } });
      applyWidgetSettings();

      // reset：位置应回到主屏右上角
      widgetWin.setBounds({ x: 60, y: 400, width: 300, height: 236 });
      await wait(200);
      widgetResults.push(...(await pageClick([['#menu button[data-act="reset"]', '菜单:reset']])));
      await wait(300);
      const resetOk = widgetWin.getBounds().x > screen.getPrimaryDisplay().workArea.width / 2;
      expect('菜单「重置位置」把窗口移回右上角', resetOk, `x=${widgetWin.getBounds().x}`);

      // 打开主面板（放最后，不影响窗口可见性断言）
      widgetResults.push(...(await pageClick([['#menu button[data-act="open"]', '菜单:open']])));
      await wait(350);
      expect('E2E 菜单「打开主面板」后主窗口可见', dashboardWin && dashboardWin.isVisible(), '主窗口未显示');

      // 2c) 最后点「隐藏」，确认窗口真的隐藏
      await pageClick([['#b-close', '隐藏']]);
      await wait(400);
      expect('E2E 悬浮窗「隐藏」后窗口已隐藏', !widgetWin.isVisible(), '窗口仍然可见');
      expect('E2E 隐藏后设置已同步', settings().widget.enabled === false, 'widget.enabled 仍为 true');

      // 3) 鼠标穿透：窗口忽略点击 → 提示条出现 → 快捷键/托盘可恢复
      store.saveSettings({ widget: { clickThrough: true, enabled: true } });
      applyWidgetSettings();
      await wait(400);
      const hintVisible = await widgetWin.webContents.executeJavaScript("!document.querySelector('#ct-hint').classList.contains('hidden')");
      toggleWidgetByHotkey();
      await wait(300);
      const recovered = !settings().widget.clickThrough;
      store.saveSettings({ widget: { clickThrough: true } });
      applyWidgetSettings();
      await wait(200);
      await buildTrayMenu().items.find((i) => /鼠标穿透/.test(i.label)).click({ checked: false });
      await wait(300);
      const recoveredByTray = !settings().widget.clickThrough;

      console.log('TRAY_MENU ' + JSON.stringify(trayResults, null, 1));
      console.log('WIDGET_BUTTONS ' + JSON.stringify(widgetResults, null, 1));
      console.log(
        'CLICK_THROUGH ' +
          JSON.stringify({ hintVisible, recoveredByHotkey: recovered, recoveredByTray, finalClickThrough: settings().widget.clickThrough })
      );
      console.log(`TRAY_SUMMARY ok=${trayResults.filter((r) => r.ok).length} fail=${trayResults.filter((r) => r.ok === false).length} skipped=${trayResults.filter((r) => r.skipped).length}`);
      console.log(`WIDGET_SUMMARY ok=${widgetResults.filter((r) => r.ok).length} fail=${widgetResults.filter((r) => r.ok === false).length}`);
      console.log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors, null, 1));

      // 还原设置并重新应用（自检不留痕）
      store.saveSettings(settingsBackup);
      applyWidgetSettings();
      updateTray();
      console.log('UITEST_DONE');
      setTimeout(() => quitApp(), 400);
      return;
    }

    // DOM 自检：--verify 渲染各页面并回读关键 DOM 文本 + 控制台错误
    if (process.argv.includes('--verify')) {
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const probe = `(() => ({
        title: document.title,
        windows: [...document.querySelectorAll('.wcard')].map(c => c.innerText.replace(/\\n+/g, ' | ')),
        kpis: [...document.querySelectorAll('.kpi')].map(c => c.innerText.replace(/\\n+/g, ' = ')),
        projections: [...document.querySelectorAll('#projection-body tr')].map(r => r.innerText.replace(/\\n+/g, ' | ')),
        plan: document.querySelector('#plan-kv')?.innerText.replace(/\\n+/g, ' | '),
        tips: document.querySelector('#tips')?.innerText.replace(/\\n+/g, ' // '),
        models: document.querySelectorAll('#models-body tr').length,
        firstModel: document.querySelector('#models-body tr')?.innerText.replace(/\\n+/g, ' | '),
        pricingMeta: document.querySelector('#pricing-meta')?.innerText,
        settingsCred: document.querySelector('#cred-source')?.innerText,
        statusLeft: document.querySelector('#status-left')?.innerText,
        diag: document.querySelector('#diag-info')?.innerText?.slice(0, 700) ?? null,
        alert: document.querySelector('#alert-bar')?.classList.contains('hidden') ? null : document.querySelector('#alert-bar')?.innerText,
      }))()`;
      await wait(2500);
      for (const tab of ['overview', 'history', 'pricing', 'settings', 'diagnostics']) {
        dashboardWin?.webContents.send('ui:navigate', tab);
        await wait(700);
        const r = await dashboardWin.webContents.executeJavaScript(probe);
        console.log(`VERIFY[${tab}] ` + JSON.stringify(r, null, 1));
      }
      const wprobe = `(() => ({
        title: document.title,
        bodyText: document.body.innerText.slice(0, 400),
        hasBridge: typeof window.cc,
        derivedBurn: typeof state !== 'undefined' ? JSON.stringify({ burn: state && state.derived && state.derived.burn, fetchedAt: state && state.snapshot && state.snapshot.fetchedAt, refreshing: state && state.meta && state.meta.refreshing }) : 'no-state-binding',
        widgetSettingsHasWidget: typeof settings !== 'undefined' ? JSON.stringify(settings && settings.widget ? Object.keys(settings.widget).length : settings) : 'no-settings',
        rows: [...document.querySelectorAll('#rows .row')].map(r => r.innerText.replace(/\\n+/g, ' | ')),
        foot: document.querySelector('#wfoot-left')?.innerText + ' / ' + document.querySelector('#wfoot-right')?.innerText,
        wtitle: document.querySelector('#wtitle-text')?.innerText,
        zoom: document.body.style.zoom,
      }))()`;
      console.log('VERIFY[widget] ' + JSON.stringify(await widgetWin.webContents.executeJavaScript(wprobe), null, 1));

      // 交互自检：悬浮窗动作 / 设置副作用 / 托盘 / 快捷键 / 通知 / 采样
      const interactions = [];
      const check = async (name, fn) => {
        try {
          await fn();
          interactions.push({ name, ok: true });
        } catch (err) {
          interactions.push({ name, ok: false, error: err.message });
        }
      };
      await check('widget.hide', () => setWidgetEnabled(false));
      await check('widget.show', () => setWidgetEnabled(true));
      await check('widget.compact', async () => {
        store.saveSettings({ widget: { compact: true } });
        applyWidgetSettings();
      });
      await check('widget.horizontal', async () => {
        store.saveSettings({ widget: { orientation: 'horizontal' } });
        applyWidgetSettings();
      });
      await check('widget.scale-1.5', async () => {
        store.saveSettings({ widget: { scale: 1.5 } });
        applyWidgetSettings();
      });
      await check('widget.opacity', async () => {
        store.saveSettings({ widget: { opacity: 0.7 } });
        applyWidgetSettings();
        await wait(160);
        const got = Number(widgetWin.getOpacity().toFixed(2));
        if (Math.abs(got - 0.7) > 0.05) throw new Error(`opacity 未生效: ${got}`);
      });
      await check('widget.size-nonzero', async () => {
        const b = widgetWin.getBounds();
        if (!b.width || !b.height) throw new Error('窗口尺寸为 0');
      });
      await check('widget.click-through', async () => {
        store.saveSettings({ widget: { clickThrough: true } });
        applyWidgetSettings();
        store.saveSettings({ widget: { clickThrough: false } });
        applyWidgetSettings();
      });
      await check('widget.reset', async () => {
        store.saveSettings({ widget: { compact: false, orientation: 'vertical', scale: 1, opacity: 0.94, bounds: null } });
        applyWidgetSettings();
      });
      await check('tray.update', () => updateTray());
      await check('tray.menu', () => {
        const m = buildTrayMenu();
        if (!m.items.length) throw new Error('托盘菜单为空');
      });
      await check('hotkey.register', () => registerHotkey());
      await check('notify.supported', () => {
        if (!Notification.isSupported()) throw new Error('系统不支持通知');
      });
      await check('history.sample', () => pushSample(snapshot));
      await check('derived.compute', () => {
        derived = computeDerived(snapshot);
        if (!derived?.projection?.fiveHour) throw new Error('预测为空');
      });
      await check('export-pricing-csv-content', () => {
        const models = pricingRaw?.models ?? [];
        if (!models.length) throw new Error('价目表为空');
        const head = 'name,modelId,context,intelligence,tokPerSec,inputUSD,outputUSD,cacheReadUSD,cacheWriteUSD,perRequestUSD,free';
        const csv = [head, ...models.map((m) => [m.name, m.modelId, m.input, m.output].join(','))].join('\n');
        if (csv.split('\n').length < 20) throw new Error('CSV 行数异常');
      });
      await check('theme.light', async () => {
        store.saveSettings({ theme: 'light' });
        applySideEffects('', settings());
      });
      await check('theme.dark', async () => {
        store.saveSettings({ theme: 'dark' });
        applySideEffects('', settings());
      });
      await check('settings.persist', async () => {
        store.saveSettings({ refreshIntervalSec: 30 });
        schedule();
        if (!nextRefreshAt) throw new Error('调度未生效');
        store.saveSettings({ refreshIntervalSec: 60 });
        schedule();
      });
      await check('pricing.decorate', () => {
        const d = pricing.decorate(pricingRaw, { freshInputTokens: 800, cacheReadTokens: 50000, outputTokens: 175 });
        const m = d.models.find((x) => x.name.includes('DeepSeek V4.1 Flash'));
        if (!m?.perRequest) throw new Error('单次成本计算为空');
      });
      await check('refresh.second', async () => {
        const r = await refresh('verify');
        if (!r.ok) throw new Error(r.error?.message || '刷新失败');
      });
      console.log('INTERACTIONS ' + JSON.stringify(interactions, null, 1));
      const failed = interactions.filter((i) => !i.ok);
      console.log(`INTERACTIONS_SUMMARY ok=${interactions.length - failed.length} fail=${failed.length}`);
      console.log('CONSOLE_ERRORS ' + JSON.stringify(consoleErrors, null, 1));
      console.log('VERIFY_DONE');
      setTimeout(() => quitApp(), 400);
      return;
    }
  });

  app.on('window-all-closed', (e) => {
    // 保持托盘常驻
    if (app.isQuitting) app.quit();
  });
  app.on('before-quit', () => {
    app.isQuitting = true;
    try {
      unwatchAuth?.();
    } catch {}
  });
  app.on('activate', () => showDashboard());
}
