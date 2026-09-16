'use strict';
/* 桌面悬浮窗渲染逻辑 */

let state = null;
let settings = null;
let history = { samples: [] };
let now = Date.now();

const $ = (s) => document.querySelector(s);

const money = (n, d = 2) => (n == null ? '—' : `$${Number(n).toFixed(d)}`);

function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return '重置中';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${mi}分`;
  if (mi > 0) return `${mi}分${s}秒`;
  return `${s}秒`;
}

const toneOf = (usedPct) => (usedPct >= 95 ? 'danger' : usedPct >= 85 ? 'orange' : usedPct >= 70 ? 'warn' : 'ok');
const toneVar = (usedPct) => `var(--${toneOf(usedPct)})`;

/** 全局快捷键显示成 Ctrl + Shift + Q 这种可读形式 */
function hotkeyLabel() {
  const accel = settings?.globalHotkey || 'CommandOrControl+Shift+Q';
  return accel.replace('CommandOrControl', navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl').replace(/\+/g, ' + ');
}

function render() {
  if (!settings) return;
  const w = settings.widget;
  document.body.dataset.orientation = w.orientation || 'vertical';
  document.body.dataset.compact = String(Boolean(w.compact));
  document.body.dataset.locked = String(Boolean(w.locked));
  document.body.dataset.clickthrough = String(Boolean(w.clickThrough));
  document.body.style.zoom = String(w.scale || 1);
  document.documentElement.style.setProperty('--accent', w.accent || '#22d3ee');
  if (w.opacity != null) document.documentElement.style.setProperty('--bg', `rgba(13, 18, 30, ${Math.max(0.35, Number(w.opacity))})`);

  $('#whead').style.display = w.showHeader ? '' : 'none';
  $('#b-pin').classList.toggle('active', Boolean(w.alwaysOnTop));
  $('#spark-wrap').classList.toggle('hidden', !w.showSparkline);

  // 鼠标穿透时给出可视提示（此时窗口收不到点击，靠快捷键 / 托盘菜单恢复）
  const hint = $('#ct-hint');
  if (hint) {
    hint.classList.toggle('hidden', !w.clickThrough);
    if (w.clickThrough) $('#ct-key').textContent = hotkeyLabel();
  }

  const snap = state?.snapshot;
  const dot = $('#wdot');
  dot.className = 'wdot';
  if (state?.meta?.refreshing) dot.classList.add('busy');
  else if (snap) dot.classList.add(state?.meta?.lastError ? 'err' : 'ok');

  $('#wtitle-text').textContent = snap?.plan?.name
    ? `${snap.plan.name} · ${snap.account?.userName || ''}`.trim()
    : 'GOAT 额度';

  const keys = [
    w.showFiveHour && 'fiveHour',
    w.showWeekly && 'weekly',
    w.showMonthly && 'monthly',
  ].filter(Boolean);

  const rows = $('#rows');
  if (!snap) {
    rows.innerHTML = `<div class="row"><div class="row-head"><span class="row-name">等待数据</span></div>
      <div class="row-foot"><span>${state?.meta?.credential?.error || '正在连接 Command Code…'}</span></div></div>`;
  } else {
    rows.innerHTML = keys
      .map((key) => {
        const win = snap.windows[key];
        const proj = state.derived?.projection?.[key];
        const burn = state.derived?.burn?.[key];
        const c = toneVar(win.usedPct);
        const risk = proj?.exhaustBeforeReset ? `<span style="color:var(--danger)">⚠ ${fmtDur(proj.exhaustsAt - now)}后耗尽</span>` : '';
        const foot = `${w.showCountdown ? `${fmtDur(win.resetsInMs)} 后重置` : ''}${w.showSpent ? ` · 已用 ${money(win.used)}` : ''}${burn ? ` · ${money(burn.usdPerHour, 3)}/h` : ''}`;
        const shortLabel = win.label.replace(/\s*\(.*\)\s*$/, '');
        return `<div class="row">
          <div class="row-head">
            <span class="row-name">${shortLabel}</span>
            <span class="row-pct" style="color:${c}">${win.remainingPct.toFixed(0)}%</span>
            <span class="row-money" style="color:${c}">${money(win.remaining)}</span>
          </div>
          <div class="bar"><i style="width:${Math.min(100, win.usedPct)}%;background:${c}"></i></div>
          <div class="row-foot"><span>${foot}</span>${risk}</div>
        </div>`;
      })
      .join('');
  }

  $('#wfoot-left').textContent = snap ? `更新 ${new Date(snap.fetchedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '—';
  const next = state?.meta?.nextRefreshAt;
  $('#wfoot-right').textContent = next && settings.autoRefresh ? `${Math.max(0, Math.round((next - now) / 1000))}s 后刷新` : state?.meta?.lastError ? '刷新失败' : '';

  drawSpark();
}

function drawSpark() {
  if (!settings?.widget?.showSparkline) return;
  const canvas = $('#spark');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 280;
  const h = 34;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const samples = history.samples.filter((s) => now - s.t <= 2 * 3600 * 1000 && s.fh != null);
  if (samples.length < 2) return;
  const max = Math.max(...samples.map((s) => s.fh), 0.01);
  const px = (i) => (i / (samples.length - 1)) * (w - 2) + 1;
  const py = (v) => h - 3 - (v / max) * (h - 8);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(34,211,238,0.55)');
  grad.addColorStop(1, 'rgba(34,211,238,0.02)');
  ctx.beginPath();
  ctx.moveTo(px(0), h);
  samples.forEach((s, i) => ctx.lineTo(px(i), py(s.fh)));
  ctx.lineTo(px(samples.length - 1), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.beginPath();
  samples.forEach((s, i) => (i ? ctx.lineTo(px(i), py(s.fh)) : ctx.moveTo(px(i), py(s.fh))));
  ctx.strokeStyle = settings.widget.accent || '#22d3ee';
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

/* ------------------------------------------------------------------ 交互 */

const act = (action, value) => cc.widgetAction(action, value);

$('#b-refresh').addEventListener('click', () => cc.refresh('widget'));
$('#b-pin').addEventListener('click', () => act('pin'));
$('#b-open').addEventListener('click', () => cc.showDashboard());
$('#b-close').addEventListener('click', () => act('hide'));
$('#b-menu').addEventListener('click', (e) => {
  e.stopPropagation();
  const m = $('#menu');
  m.classList.toggle('hidden');
  m.querySelector('[data-act="top"]').classList.toggle('active', Boolean(settings.widget.alwaysOnTop));
  m.querySelector('[data-act="click"]').classList.toggle('active', Boolean(settings.widget.clickThrough));
  m.querySelector('[data-act="compact"]').classList.toggle('active', Boolean(settings.widget.compact));
  m.querySelector('[data-act="lock"]').classList.toggle('active', Boolean(settings.widget.locked));
  m.querySelector('[data-act="near"]').classList.toggle('active', Boolean(settings.widget.snapToEdges));
});

document.addEventListener('click', () => $('#menu').classList.add('hidden'));

$('#menu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const a = btn.dataset.act;
  if (a === 'open') cc.showDashboard();
  else if (a === 'top') await act('pin', !settings.widget.alwaysOnTop);
  else if (a === 'click') await act('clickThrough', !settings.widget.clickThrough);
  else if (a === 'compact') await act('compact', !settings.widget.compact);
  else if (a === 'lock') await act('lock', !settings.widget.locked);
  else if (a === 'near') settings = await cc.saveSettings({ widget: { snapToEdges: !settings.widget.snapToEdges } });
  else if (a === 'orient') {
    settings = await cc.saveSettings({ widget: { orientation: settings.widget.orientation === 'horizontal' ? 'vertical' : 'horizontal' } });
    await act('resize');
  } else if (a === 'reset') await act('resetPosition');
  else if (a === 'hide') await act('hide');
  else if (a === 'quit') cc.quit();
  $('#menu').classList.add('hidden');
  render();
});

async function boot() {
  settings = await cc.getWidgetSettings();
  state = await cc.getState();
  history = await cc.getHistory(Date.now() - 6 * 3600 * 1000);
  render();

  cc.onState((s) => {
    state = s;
    // 主进程会把最新设置随广播下发，立即生效（不必等 2 秒轮询）
    if (s.meta?.widgetSettings || s.meta?.globalHotkey) {
      settings = {
        ...settings,
        globalHotkey: s.meta.globalHotkey || settings?.globalHotkey,
        widget: { ...(settings?.widget || {}), ...(s.meta.widgetSettings || {}) },
      };
    }
    render();
  });
  cc.onTick(({ now: t }) => {
    now = t;
    render();
  });
  cc.onTheme(() => render());
  setInterval(async () => {
    now = Date.now();
    history = await cc.getHistory(Date.now() - 6 * 3600 * 1000);
    render();
  }, 30000);
  // 设置被主面板修改后同步
  setInterval(async () => {
    const s = await cc.getWidgetSettings();
    if (JSON.stringify(s) !== JSON.stringify(settings)) {
      settings = s;
      cc.widgetAction('resize');
      render();
    }
  }, 2000);
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:10px;color:#f88;font-size:11px">悬浮窗初始化失败：${err?.message || err}</pre>`;
});
