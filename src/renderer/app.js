'use strict';
/* Command Code 额度监控 —— 主面板渲染逻辑 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const S = {
  state: null,
  settings: null,
  pricing: null,
  history: { samples: [] },
  tab: 'overview',
  range: 6 * 3600 * 1000,
  chartMode: 'used',
  sortKey: 'cost',
  search: '',
  onlyGoat: true,
  hideFree: false,
  profile: { freshInputTokens: 800, cacheReadTokens: 50000, outputTokens: 175 },
  now: Date.now(),
};

/* ------------------------------------------------------------- utilities */

const money = (n, digits = 2) => (n == null || Number.isNaN(n) ? '—' : `$${Number(n).toFixed(digits)}`);
const pct = (n) => (n == null ? '—' : `${Number(n).toFixed(1)}%`);
const int = (n) => (n == null ? '—' : Number(n).toLocaleString('zh-CN'));
const compactNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(v);
};

function fmtDur(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return '已重置';
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mi = m % 60;
  const s = Math.floor((ms % 60000) / 1000);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${mi} 分`;
  if (mi > 0) return `${mi} 分 ${s} 秒`;
  return `${s} 秒`;
}

const tone = (usedPct) => (usedPct >= 95 ? 'danger' : usedPct >= 85 ? 'orange' : usedPct >= 70 ? 'warn' : 'ok');
const toneVar = (usedPct) => {
  const t = tone(usedPct);
  return `var(--${t === 'orange' ? 'orange' : t})`;
};

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts.at(-1)] = value;
  return obj;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/* -------------------------------------------------------------- data load */

async function boot() {
  S.settings = await cc.getSettings();
  S.state = await cc.getState();
  S.pricing = await cc.getPricing();
  S.history = await cc.getHistory(0);
  S.profile = { ...S.profile, ...(S.settings.modelTable?.profile || {}) };
  S.onlyGoat = S.settings.modelTable?.onlyGoat ?? false;

  applyTheme(S.settings.theme);
  applySettingsToForm();
  renderAll();

  cc.onState((state) => {
    S.state = state;
    renderAll();
  });
  cc.onTick(({ now }) => {
    S.now = now;
    tickCountdowns();
    updateRefreshEta();
  });
  cc.onNavigate((tab) => switchTab(tab));
  cc.onTheme((theme) => applyTheme(theme));

  setInterval(() => {
    S.now = Date.now();
    tickCountdowns();
  }, 1000);
  setInterval(async () => {
    S.history = await cc.getHistory(0);
    if (S.tab === 'history') renderHistory();
  }, 60000);

  bindEvents();
}

function renderAll() {
  renderHeader();
  renderWindows();
  renderKpis();
  renderProjection();
  renderPlanKv();
  renderTips();
  renderStatus();
  if (S.tab === 'history') renderHistory();
  if (S.tab === 'pricing') renderPricing();
  if (S.tab === 'diagnostics') renderDiagnostics();
}

/* ---------------------------------------------------------------- header */

function renderHeader() {
  const st = S.state || {};
  const meta = st.meta || {};
  const snap = st.snapshot;
  const dot = $('#status-dot');
  dot.className = 'dot';
  if (meta.refreshing) dot.classList.add('busy');
  else if (meta.lastError && !snap) dot.classList.add('err');
  else if (snap) dot.classList.add('ok');

  $('#account-name').textContent = snap?.account?.userName || meta.credential?.userName || '未连接';
  $('#plan-chip').textContent = snap?.plan?.name
    ? `${snap.plan.name}${meta.demo ? ' · DEMO' : ''}${snap.plan.status && snap.plan.status !== 'active' ? ` · ${snap.plan.status}` : ''}`
    : '未知套餐';
  $('#brand-sub').textContent = snap
    ? `${meta.demo ? '演示数据 · ' : ''}更新于 ${new Date(snap.fetchedAt).toLocaleTimeString()} · 延迟 ${snap.latencyMs ?? '—'}ms · 间隔 ${meta.intervalSec ?? '—'}s`
    : meta.credential?.ok
      ? '尚未获取到数据'
      : meta.credential?.error || '等待连接';

  const bar = $('#alert-bar');
  const problems = [];
  if (meta.lastError) problems.push(`⚠ ${meta.lastError.message}`);
  if (meta.credential && !meta.credential.ok) problems.push(`⚠ ${meta.credential.error}（可在「设置 → 账号与连接」中填写 API Key）`);
  if (snap) {
    for (const key of ['fiveHour', 'weekly', 'monthly']) {
      const w = snap.windows[key];
      if (w.exceeded) problems.push(`⛔ ${w.label}额度已用尽，将在 ${fmtDur(w.resetsInMs)} 后重置`);
    }
  }
  if (problems.length) {
    bar.textContent = problems.join('    ');
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
  $('#btn-widget').classList.toggle('active', Boolean(S.settings?.widget?.enabled));
}

function updateRefreshEta() {
  const meta = S.state?.meta;
  if (!meta || !meta.nextRefreshAt || !S.settings?.autoRefresh) {
    $('#refresh-eta').textContent = '';
    return;
  }
  const left = Math.max(0, Math.round((meta.nextRefreshAt - S.now) / 1000));
  $('#refresh-eta').textContent = `${left}s`;
}

/* --------------------------------------------------------- window cards */

function renderWindows() {
  const host = $('#window-cards');
  const snap = S.state?.snapshot;
  if (!snap) {
    host.innerHTML = ['5 小时', '每周', '每月']
      .map(
        (label) => `<div class="wcard" style="--tone:var(--border)">
        <div class="wcard-head"><span class="wcard-title">${label}额度</span></div>
        <div class="wcard-nums"><div class="big-money">—</div><div class="muted small">暂无数据，请先连接账号</div></div>
      </div>`
      )
      .join('');
    return;
  }

  const order = ['fiveHour', 'weekly', 'monthly'];
  host.innerHTML = order
    .map((key) => {
      const w = snap.windows[key];
      const proj = S.state.derived?.projection?.[key];
      const burn = S.state.derived?.burn?.[key];
      const c = toneVar(w.usedPct);
      const r = 52;
      const circ = 2 * Math.PI * r;
      const dash = (Math.max(0, Math.min(100, w.remainingPct)) / 100) * circ;
      const projText = proj?.exhaustBeforeReset
        ? `<span class="text-danger">按当前速率将于 ${fmtDur(proj.exhaustsAt - S.now)}后耗尽</span>`
        : proj?.hoursToExhaust
          ? `<span class="text-ok">可撑到重置（约 ${fmtDur(proj.hoursToExhaust * 3600000)}）</span>`
          : '<span class="muted">速率样本不足</span>';
      return `
      <div class="wcard" style="--tone:${c}">
        <div class="wcard-head">
          <span class="wcard-title">${w.label}${key === 'monthly' ? ' · 订阅周期' : ''}</span>
          <span class="pill ${tone(w.usedPct) === 'ok' ? 'ok' : tone(w.usedPct) === 'warn' ? 'warn' : 'danger'}">${w.exceeded ? '已用尽' : `已用 ${pct(w.usedPct)}`}</span>
        </div>
        <div class="wcard-body">
          <div class="ring">
            <svg width="118" height="118" viewBox="0 0 118 118">
              <circle cx="59" cy="59" r="${r}" fill="none" stroke="var(--card-2)" stroke-width="10" />
              <circle cx="59" cy="59" r="${r}" fill="none" stroke="${c}" stroke-width="10" stroke-linecap="round"
                stroke-dasharray="${dash} ${circ}" />
            </svg>
            <div class="ring-label">
              <div>
                <div class="ring-pct" style="color:${c}">${w.remainingPct.toFixed(0)}%</div>
                <div class="ring-sub">剩余比例</div>
              </div>
            </div>
          </div>
          <div class="wcard-nums">
            <div class="big-money">${money(w.remaining)}<span class="unit">/ ${money(w.cap)}</span></div>
            <div class="bar"><i style="width:${w.usedPct}%"></i></div>
            <div class="wcard-meta">
              <span>已用 ${money(w.used)}</span>
              <span>窗口 ${money(w.cap)}</span>
            </div>
          </div>
        </div>
        <div class="wcard-foot">
          <span class="muted">重置：<b data-countdown="${w.resetAt ?? ''}" data-kind="dur">—</b>后</span>
          <span class="muted">速率：${burn ? `${money(burn.usdPerHour, 3)}/h` : '—'}</span>
        </div>
        <div class="wcard-foot">${projText}</div>
      </div>`;
    })
    .join('');
  tickCountdowns();
}

function tickCountdowns() {
  const now = S.now || Date.now();
  $$('[data-countdown]').forEach((el) => {
    const t = Number(el.dataset.countdown);
    if (!t) {
      el.textContent = '—';
      return;
    }
    el.textContent = fmtDur(t - now);
  });
  $$('[data-clock]').forEach((el) => {
    const t = Number(el.dataset.clock);
    if (t) el.textContent = new Date(t).toLocaleString('zh-CN', { hour12: false });
  });
}

/* ------------------------------------------------------------------ kpis */

function renderKpis() {
  const snap = S.state?.snapshot;
  const host = $('#kpi-cards');
  if (!snap) {
    host.innerHTML = '';
    return;
  }
  const p = snap.periodUsage;
  const c = snap.credits;
  const items = [
    { label: '本周期请求数', value: int(p?.totalCount), sub: `成功率 ${p ? p.successRate.toFixed(1) : '—'}% · 失败 ${int(p?.failedCount)}` },
    { label: '本周期花费', value: money(p?.totalCost), sub: `平均 ${money(p?.averageCost, 4)} / 次请求` },
    { label: 'Token 总量', value: compactNum(p?.totalTokens), sub: `输入 ${compactNum(p?.totalTokensIn)} · 输出 ${compactNum(p?.totalTokensOut)}` },
    { label: '每百万 token 成本', value: p?.totalTokens ? money((p.totalCost / p.totalTokens) * 1e6, 3) : '—', sub: '本周期总花费 ÷ 总 token' },
    { label: '月度剩余额度', value: money(c?.totalRemaining), sub: `订阅额度 ${money(c?.monthlyRemaining)} · 加购 ${money(c?.purchasedRemaining)} · 赠送 ${money(c?.freeRemaining)}` },
    { label: '周期剩余天数', value: snap.plan?.periodDaysLeft != null ? `${snap.plan.periodDaysLeft} 天` : '—', sub: snap.plan?.currentPeriodEnd ? `到期 ${new Date(snap.plan.currentPeriodEnd).toLocaleDateString('zh-CN')}` : '—' },
  ];
  host.innerHTML = items
    .map(
      (i) => `<div class="kpi"><div class="kpi-label">${i.label}</div><div class="kpi-value">${i.value}</div><div class="kpi-sub">${i.sub}</div></div>`
    )
    .join('');
}

function renderProjection() {
  const snap = S.state?.snapshot;
  const body = $('#projection-body');
  if (!snap) {
    body.innerHTML = '<tr><td colspan="5" class="muted">暂无数据</td></tr>';
    return;
  }
  body.innerHTML = ['fiveHour', 'weekly', 'monthly']
    .map((key) => {
      const w = snap.windows[key];
      const proj = S.state.derived?.projection?.[key] || {};
      const burn = S.state.derived?.burn?.[key];
      const status = w.exceeded
        ? '<span class="text-danger">已用尽</span>'
        : proj.exhaustBeforeReset
          ? `<span class="text-danger">将在重置前 ${fmtDur(proj.exhaustsAt - S.now)}后耗尽</span>`
          : burn
            ? '<span class="text-ok">安全，可撑到重置</span>'
            : '<span class="muted">等待更多采样</span>';
      return `<tr>
        <td>${shortLabel(w)}</td>
        <td class="num">${burn ? `${money(burn.usdPerHour, 3)}/h` : '—'}</td>
        <td class="num">${burn && burn.usdPerHour > 0 ? fmtDur((w.remaining / burn.usdPerHour) * 3600000) : '—'}</td>
        <td class="num">${money(proj.neededRateToLast, 3)}/h</td>
        <td>${status}</td>
      </tr>`;
    })
    .join('');
}

function renderPlanKv() {
  const snap = S.state?.snapshot;
  const el = $('#plan-kv');
  if (!snap) {
    el.innerHTML = '<dt>状态</dt><dd>未连接</dd>';
    return;
  }
  const rows = [
    ['账号', snap.account.userName || '—'],
    ['邮箱', snap.account.email || '—'],
    ['套餐', snap.plan.name ? `${snap.plan.name}（${snap.plan.planId}）` : '—'],
    ['订阅状态', snap.plan.status || '—'],
    ['计费周期开始', snap.plan.currentPeriodStart ? new Date(snap.plan.currentPeriodStart).toLocaleString('zh-CN', { hour12: false }) : '—'],
    ['计费周期结束', snap.plan.currentPeriodEnd ? new Date(snap.plan.currentPeriodEnd).toLocaleString('zh-CN', { hour12: false }) : '—'],
    ['周期结束倒计时', snap.windows.monthly.resetAt ? `<b data-countdown="${snap.windows.monthly.resetAt}">—</b>` : '—'],
    ['即将取消', snap.plan.cancelAtPeriodEnd ? '是（周期末生效）' : '否'],
    ['订阅 ID', `<span class="mono">${snap.plan.subscriptionId || '—'}</span>`],
  ];
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  tickCountdowns();
}

const shortLabel = (w) => (w?.label ? w.label.replace(/\s*\(.*\)\s*$/, '') : '');

function renderTips() {
  const snap = S.state?.snapshot;
  const el = $('#tips');
  const tips = [];
  if (!snap) {
    tips.push('尚未获取数据：如果是首次使用，请确认已在本机运行过 <code>cmd</code> 并登录（会自动复用 ~/.commandcode/auth.json）。');
  } else {
    for (const key of ['fiveHour', 'weekly', 'monthly']) {
      const w = snap.windows[key];
      const proj = S.state.derived?.projection?.[key];
      if (!w) continue;
      if (proj?.neededRateToLast != null && w.remainingPct < 100) {
        tips.push(
          `想把${shortLabel(w)}额度用满到重置：接下来保持不超过 <b>${money(proj.neededRateToLast, 3)}/小时</b>（剩余 ${money(w.remaining)}，还有 ${fmtDur(w.resetsInMs)} 重置）。`
        );
      }
      if (proj?.exhaustBeforeReset) {
        tips.push(`⚠ ${shortLabel(w)}额度按当前速率会在重置前耗尽，建议切换到更便宜的模型（见「模型价目表」按单次成本排序）。`);
      }
    }
    const price = S.pricing?.plan?.monthlyPrice;
    const cap = snap.windows.monthly.cap;
    if (price && cap) {
      tips.push(`GOAT 套餐 $${price}/月 包含 $${cap} 额度，相当于 <b>${(cap / price).toFixed(1)}×</b> 倍杠杆；本月已用 ${money(snap.windows.monthly.used)}（${pct(snap.windows.monthly.usedPct)}）。`);
    }
    const p = snap.periodUsage;
    if (p?.totalCount) {
      tips.push(`本周期共 ${int(p.totalCount)} 次请求，平均 ${money(p.averageCost, 4)}/次；按当前日均消耗，本周期结束时预计剩余 <b>${money(estimatePeriodEnd(snap), 2)}</b>。`);
    }
    if (snap.windows.fiveHour.remainingPct < 20) {
      tips.push('5 小时窗口剩余不足 20%：已自动把刷新间隔提速，悬浮窗会实时显示剩余额度。');
    }
  }
  el.innerHTML = tips.map((t) => `<li>${t}</li>`).join('') || '<li class="muted">暂无建议</li>';
}

function estimatePeriodEnd(snap) {
  const usedPerDay = dailyRate(snap);
  if (!usedPerDay) return snap.windows.monthly.remaining;
  const daysLeft = Math.max(0, snap.plan?.periodDaysLeft ?? 0);
  return Math.max(0, snap.windows.monthly.remaining - usedPerDay * daysLeft);
}

function dailyRate(snap) {
  const samples = S.history.samples.filter((s) => S.now - s.t <= 24 * 3600 * 1000 && s.mo != null);
  if (samples.length < 2) return null;
  const seg = samples.filter((s) => s.moReset === samples.at(-1).moReset);
  if (seg.length < 2) return null;
  const d = seg.at(-1).mo - seg[0].mo;
  const dt = seg.at(-1).t - seg[0].t;
  if (dt < 3600000 || d < 0) return null;
  return (d / dt) * 86400000;
}

/* --------------------------------------------------------------- history */

function renderHistory() {
  const canvas = $('#history-chart');
  const samples = S.history.samples.filter((s) => S.now - s.t <= S.range);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 900;
  const h = 280;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.body);
  const colors = {
    fiveHour: css.getPropertyValue('--accent').trim() || '#22d3ee',
    weekly: '#a78bfa',
    monthly: '#f59e0b',
    grid: css.getPropertyValue('--border').trim() || '#253148',
    text: css.getPropertyValue('--muted').trim() || '#8d9ab4',
  };

  if (samples.length < 2) {
    ctx.fillStyle = colors.text;
    ctx.font = '13px "Segoe UI", sans-serif';
    ctx.fillText('采样点不足，保持应用运行即可累积曲线（每 1 分钟记录一个点）', 20, h / 2);
    $('#chart-legend').innerHTML = '';
    renderHistoryStats(samples);
    renderSamplesTable();
    return;
  }

  const pad = { l: 52, r: 16, t: 14, b: 26 };
  const series = [
    { key: 'fiveHour', field: 'fh', cap: 'fhCap' },
    { key: 'weekly', field: 'wk', cap: 'wkCap' },
    { key: 'monthly', field: 'mo', cap: 'moCap' },
  ];

  const value = (s, ser) => {
    if (S.chartMode === 'used') return s[ser.field] ?? 0;
    if (S.chartMode === 'remain') return Math.max(0, (s[ser.cap] ?? 0) - (s[ser.field] ?? 0));
    const cap = s[ser.cap] ?? 0;
    return cap > 0 ? Math.min(100, ((s[ser.field] ?? 0) / cap) * 100) : 0;
  };

  let maxY = 0;
  for (const s of samples) for (const ser of series) maxY = Math.max(maxY, value(s, ser));
  maxY = maxY <= 0 ? 1 : maxY * 1.12;
  const x0 = samples[0].t;
  const x1 = samples.at(-1).t || x0 + 1;
  const px = (t) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
  const py = (v) => h - pad.b - (v / maxY) * (h - pad.t - pad.b);

  // 网格 + Y 轴
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = '11px "Segoe UI", sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const v = (maxY / 4) * i;
    const y = py(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(S.chartMode === 'pct' ? `${v.toFixed(0)}%` : `$${v.toFixed(2)}`, 6, y + 4);
  }

  // X 轴时间
  for (let i = 0; i <= 4; i++) {
    const t = x0 + ((x1 - x0) / 4) * i;
    const x = px(t);
    const label = new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    ctx.fillText(label, Math.min(x, w - 40), h - 8);
  }

  // 曲线
  for (const ser of series) {
    ctx.strokeStyle = colors[ser.key];
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = px(s.t);
      const y = py(value(s, ser));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  $('#chart-legend').innerHTML = `
    <span><i style="background:${colors.fiveHour}"></i>5 小时</span>
    <span><i style="background:${colors.weekly}"></i>每周</span>
    <span><i style="background:${colors.monthly}"></i>每月</span>
    <span class="muted">共 ${samples.length} 个采样点 · ${S.chartMode === 'pct' ? '使用率' : S.chartMode === 'remain' ? '剩余金额' : '已用金额'}</span>`;

  renderHistoryStats(samples);
  renderSamplesTable();
}

function renderHistoryStats(samples) {
  const host = $('#history-stats');
  const last = samples.at(-1);
  const first = samples[0];
  const perDay = dailyRate(S.state?.snapshot || {});
  const items = [
    { label: '区间起始', value: first ? new Date(first.t).toLocaleString('zh-CN', { hour12: false }) : '—', sub: '本地采样' },
    { label: '区间新增消耗', value: first && last ? money(last.mo - first.mo) : '—', sub: '按月度窗口已用金额计算' },
    { label: '近 24h 日均消耗', value: perDay ? money(perDay) : '—', sub: perDay ? `预计 7 天消耗 ${money(perDay * 7)}` : '需要更多采样' },
    { label: '采样点', value: int(S.history.samples.length), sub: `保留 ${S.settings?.historyRetentionDays ?? 30} 天` },
  ];
  host.innerHTML = items
    .map((i) => `<div class="kpi"><div class="kpi-label">${i.label}</div><div class="kpi-value">${i.value}</div><div class="kpi-sub">${i.sub}</div></div>`)
    .join('');
}

function renderSamplesTable() {
  const rows = [...S.history.samples].slice(-40).reverse();
  $('#samples-body').innerHTML =
    rows
      .map(
        (s) => `<tr>
      <td>${new Date(s.t).toLocaleString('zh-CN', { hour12: false })}</td>
      <td class="num">${money(s.fh)} / ${money(s.fhCap)}</td>
      <td class="num">${money(s.wk)} / ${money(s.wkCap)}</td>
      <td class="num">${money(s.mo)} / ${money(s.moCap)}</td>
      <td class="num">${s.cost != null ? money(s.cost) : '—'}</td>
      <td class="num">${s.req != null ? int(s.req) : '—'}</td>
    </tr>`
      )
      .join('') || '<tr><td colspan="6" class="muted">暂无采样</td></tr>';
}

/* --------------------------------------------------------------- pricing */

async function refreshPricing(profile) {
  S.profile = { ...S.profile, ...profile };
  await cc.saveSettings({ modelTable: { profile: S.profile, onlyGoat: S.onlyGoat } });
  S.pricing = await cc.getPricing();
  renderPricing();
}

function renderPricing() {
  const data = S.pricing;
  if (!data) return;
  const body = $('#models-body');
  const windowKey = $('#cap-window').value;
  const remaining = S.state?.snapshot?.windows?.[windowKey]?.remaining ?? 0;
  $('#th-capacity').textContent = `还能跑（剩 ${money(remaining)}）`;
  $('#pricing-meta').textContent = `官方数据抓取于 ${data.generatedAt ? new Date(data.generatedAt).toLocaleString('zh-CN', { hour12: false }) : '—'} · 共 ${data.models?.length ?? 0} 个 GOAT 模型`;
  $('#pricing-foot').innerHTML = `单次成本按「新鲜输入 ${int(S.profile.freshInputTokens)} tokens + 缓存读取 ${int(S.profile.cacheReadTokens)} tokens + 输出 ${int(S.profile.outputTokens)} tokens」估算，取自官方文档给出的典型 agent 请求画像；实际费用以平台结算为准。数据来源：<span class="mono">commandcode.ai/docs/plans/goat</span>`;

  let models = (data.models || []).filter((m) => m.input != null || m.free);
  if (S.onlyGoat) models = models.filter((m) => m.requests5h != null || m.free || m.creditTiers?.length);
  if (S.hideFree) models = models.filter((m) => !m.free);
  if (S.search) {
    const q = S.search.toLowerCase();
    models = models.filter((m) => `${m.name} ${m.modelId || ''} ${m.slug || ''}`.toLowerCase().includes(q));
  }

  const sorters = {
    cost: (a, b) => (a.perRequest ?? 9e9) - (b.perRequest ?? 9e9),
    input: (a, b) => (a.input ?? 9e9) - (b.input ?? 9e9),
    output: (a, b) => (a.output ?? 9e9) - (b.output ?? 9e9),
    intelligence: (a, b) => (b.intelligence ?? -1) - (a.intelligence ?? -1),
    tps: (a, b) => (b.tokensPerSecond ?? -1) - (a.tokensPerSecond ?? -1),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  models = [...models].sort(sorters[S.sortKey] || sorters.cost);

  const cheapest = Math.min(...models.filter((m) => !m.free && m.perRequest > 0).map((m) => m.perRequest).concat([Infinity]));

  body.innerHTML = models
    .map((m) => {
      const cap = m.free || !m.perRequest ? '免费' : int(Math.floor(remaining / m.perRequest));
      const isCheapest = m.perRequest && Math.abs(m.perRequest - cheapest) < 1e-9;
      return `<tr>
        <td>
          <div>${m.name} ${m.free ? '<span class="tag free">免费</span>' : ''} ${isCheapest ? '<span class="tag best">最省</span>' : ''}</div>
          ${m.note ? `<div class="mono" title="${m.note}">${m.note.slice(0, 64)}…</div>` : ''}
        </td>
        <td class="mono">${m.modelId || m.slug || '—'}</td>
        <td class="num">${m.context || '—'}</td>
        <td class="num">${m.intelligence ?? '—'}</td>
        <td class="num">${m.tokensPerSecond ?? '—'}</td>
        <td class="num">${m.free ? '免费' : money(m.input, 3)}</td>
        <td class="num">${m.free ? '免费' : money(m.output, 3)}</td>
        <td class="num">${m.free ? '免费' : money(m.cacheRead, 4)}</td>
        <td class="num">${m.cacheWrite == null ? '—' : money(m.cacheWrite, 4)}</td>
        <td class="num">${m.free ? '免费' : money(m.perRequest, 4)}</td>
        <td class="num"><b>${cap}</b></td>
        <td class="num mono">${m.official ? `${int(m.official.fiveHour)} / ${int(m.official.weekly)} / ${int(m.official.monthly)}` : '—'}</td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="12" class="muted">没有匹配的模型</td></tr>';
}

/* -------------------------------------------------------------- settings */

const BINDINGS = [
  ['#s-auto-refresh', 'autoRefresh', 'checkbox'],
  ['#s-interval', 'refreshIntervalSec', 'number'],
  ['#s-smart', 'smartRefresh', 'checkbox'],
  ['#s-widget-interval', 'widgetRefreshIntervalSec', 'number'],
  ['#s-timeout', 'requestTimeoutMs', 'number'],
  ['#s-theme', 'theme', 'text'],
  ['#s-tray-window', 'trayPercentWindow', 'text'],
  ['#s-launch', 'launchAtLogin', 'checkbox'],
  ['#s-start-min', 'startMinimized', 'checkbox'],
  ['#s-close-tray', 'closeToTray', 'checkbox'],
  ['#s-hotkey', 'globalHotkey', 'text'],
  ['#s-history', 'historyEnabled', 'checkbox'],
  ['#s-retention', 'historyRetentionDays', 'number'],
  ['#s-auto-pricing', 'autoUpdatePricing', 'checkbox'],
  ['#s-cred-mode', 'credentialsMode', 'text'],
  ['#s-base-url', 'apiBaseUrl', 'text'],
  ['#th-warn', 'thresholds.warn', 'number'],
  ['#th-critical', 'thresholds.critical', 'number'],
  ['#th-notify-warn', 'thresholds.notifyOnWarn', 'checkbox'],
  ['#th-notify-critical', 'thresholds.notifyOnCritical', 'checkbox'],
  ['#th-notify-exceeded', 'thresholds.notifyOnExceeded', 'checkbox'],
  ['#th-notify-reset', 'thresholds.notifyOnReset', 'checkbox'],
  ['#w-enabled', 'widget.enabled', 'checkbox'],
  ['#w-top', 'widget.alwaysOnTop', 'checkbox'],
  ['#w-locked', 'widget.locked', 'checkbox'],
  ['#w-click', 'widget.clickThrough', 'checkbox'],
  ['#w-compact', 'widget.compact', 'checkbox'],
  ['#w-orient', 'widget.orientation', 'text'],
  ['#w-opacity', 'widget.opacity', 'number'],
  ['#w-scale', 'widget.scale', 'number'],
  ['#w-fh', 'widget.showFiveHour', 'checkbox'],
  ['#w-wk', 'widget.showWeekly', 'checkbox'],
  ['#w-mo', 'widget.showMonthly', 'checkbox'],
  ['#w-countdown', 'widget.showCountdown', 'checkbox'],
  ['#w-spent', 'widget.showSpent', 'checkbox'],
  ['#w-spark', 'widget.showSparkline', 'checkbox'],
  ['#w-header', 'widget.showHeader', 'checkbox'],
  ['#w-accent', 'widget.accent', 'text'],
];

function applySettingsToForm() {
  const s = S.settings;
  for (const [sel, path, type] of BINDINGS) {
    const el = $(sel);
    if (!el) continue;
    const v = getPath(s, path);
    if (type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  }
  $('#s-api-key').value = s.credentialsMode === 'manual' ? s.manualApiKey || '' : '';
  $('#s-api-key').placeholder = s.credentialsMode === 'manual' ? 'user_xxxxxxxx…' : '自动模式下无需填写';
  $('#row-api-key').style.opacity = s.credentialsMode === 'manual' ? '1' : '0.45';
  $('#th-warn-val').textContent = s.thresholds.warn;
  $('#th-critical-val').textContent = s.thresholds.critical;
  $('#w-opacity-val').textContent = Number(s.widget.opacity).toFixed(2);
  $('#w-scale-val').textContent = Number(s.widget.scale).toFixed(2);
  $('#p-fresh').value = S.profile.freshInputTokens;
  $('#p-cache').value = S.profile.cacheReadTokens;
  $('#p-out').value = S.profile.outputTokens;
  $('#p-only-goat').checked = S.onlyGoat;
  $('#p-hide-free').checked = S.hideFree;
  const meta = S.state?.meta?.credential;
  $('#cred-source').textContent = meta ? (meta.ok ? `${meta.source}${meta.masked ? ` · ${meta.masked}` : ''}` : `未连接：${meta.error}`) : '—';
  $('#auth-file-path').textContent = meta?.file || '—';
  $('#data-paths').textContent = `设置与历史保存在应用数据目录（诊断页可见完整路径）`;
}

async function save(patch, { silent } = {}) {
  S.settings = await cc.saveSettings(patch);
  applyTheme(S.settings.theme);
  if (!silent) toast('设置已保存');
  renderHeader();
}

function bindEvents() {
  // 标签页
  $('#tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (btn) switchTab(btn.dataset.tab);
  });

  $('#btn-refresh').addEventListener('click', async () => {
    toast('正在刷新…');
    const r = await cc.refresh('manual');
    toast(r?.result?.ok ? '已更新' : '刷新失败，请查看诊断页');
  });
  $('#btn-refresh-now').addEventListener('click', () => cc.refresh('manual').then(() => toast('已更新')));
  $('#btn-widget').addEventListener('click', () => cc.widgetAction('toggle'));
  $('#btn-theme').addEventListener('click', () => {
    const order = ['dark', 'light', 'system'];
    const next = order[(order.indexOf(S.settings.theme) + 1) % order.length];
    save({ theme: next }, { silent: true }).then(() => toast(`主题：${next === 'dark' ? '深色' : next === 'light' ? '浅色' : '跟随系统'}`));
  });
  $('#btn-open-usage').addEventListener('click', () => cc.openUsagePage());

  // 历史
  $('#range-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#range-seg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    S.range = Number(btn.dataset.range);
    renderHistory();
  });
  $('#mode-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#mode-seg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    S.chartMode = btn.dataset.mode;
    renderHistory();
  });
  $('#btn-export-history').addEventListener('click', () => cc.exportData('history-csv').then(reportExport));
  $('#btn-export-csv2').addEventListener('click', () => cc.exportData('history-csv').then(reportExport));
  $('#btn-export-json').addEventListener('click', () => cc.exportData('snapshot').then(reportExport));
  $('#btn-export-pricing').addEventListener('click', () => cc.exportData('pricing-csv').then(reportExport));
  const clearHistory = async () => {
    await cc.clearHistory();
    S.history = await cc.getHistory(0);
    renderHistory();
    toast('历史已清空');
  };
  $('#btn-clear-history').addEventListener('click', clearHistory);
  $('#btn-clear-history2').addEventListener('click', clearHistory);

  // 价目表
  $('#cap-window').addEventListener('change', renderPricing);
  $('#model-search').addEventListener('input', (e) => {
    S.search = e.target.value.trim();
    renderPricing();
  });
  $('#sort-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#sort-seg .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    S.sortKey = btn.dataset.sort;
    renderPricing();
  });
  $('#p-only-goat').addEventListener('change', (e) => {
    S.onlyGoat = e.target.checked;
    cc.saveSettings({ modelTable: { onlyGoat: S.onlyGoat } });
    renderPricing();
  });
  $('#p-hide-free').addEventListener('change', (e) => {
    S.hideFree = e.target.checked;
    renderPricing();
  });
  for (const id of ['#p-fresh', '#p-cache', '#p-out']) {
    $(id).addEventListener('change', () => {
      refreshPricing({
        freshInputTokens: Number($('#p-fresh').value) || 0,
        cacheReadTokens: Number($('#p-cache').value) || 0,
        outputTokens: Number($('#p-out').value) || 0,
      });
    });
  }
  $('#btn-reload-pricing').addEventListener('click', async () => {
    toast('正在从官网抓取最新价目表…', 8000);
    const r = await cc.reloadPricing();
    S.pricing = await cc.getPricing();
    renderPricing();
    toast(
      r?.ok
        ? `已从 commandcode.ai 更新价目表：${r.count ?? 0} 个模型`
        : `官网抓取失败（${r?.error || '网络问题'}），已回退本地缓存：${r?.count ?? 0} 个模型`,
      4200
    );
  });

  // 设置绑定
  for (const [sel, path, type] of BINDINGS) {
    const el = $(sel);
    if (!el) continue;
    const evt = type === 'checkbox' ? 'change' : 'change';
    el.addEventListener(evt, () => {
      let v;
      if (type === 'checkbox') v = el.checked;
      else if (type === 'number') v = Number(el.value);
      else v = el.value;
      const patch = {};
      setPath(patch, path, v);
      save(patch, { silent: true });
      if (path.startsWith('thresholds')) {
        $('#th-warn-val').textContent = $('#th-warn').value;
        $('#th-critical-val').textContent = $('#th-critical').value;
      }
      if (path === 'widget.opacity') $('#w-opacity-val').textContent = Number(v).toFixed(2);
      if (path === 'widget.scale') $('#w-scale-val').textContent = Number(v).toFixed(2);
      if (path === 'credentialsMode') applySettingsToForm();
      if (path.startsWith('widget.')) cc.widgetAction('resize');
    });
  }
  $('#w-opacity').addEventListener('input', (e) => {
    $('#w-opacity-val').textContent = Number(e.target.value).toFixed(2);
    cc.saveSettings({ widget: { opacity: Number(e.target.value) } });
  });
  $('#w-scale').addEventListener('input', (e) => {
    $('#w-scale-val').textContent = Number(e.target.value).toFixed(2);
  });
  $('#th-warn').addEventListener('input', (e) => ($('#th-warn-val').textContent = e.target.value));
  $('#th-critical').addEventListener('input', (e) => ($('#th-critical-val').textContent = e.target.value));

  $('#s-api-key').addEventListener('change', (e) => save({ manualApiKey: e.target.value.trim() }, { silent: true }));
  $('#btn-test-auth').addEventListener('click', async () => {
    $('#test-result').textContent = '测试中…';
    const r = await cc.testAuth({ apiKey: $('#s-api-key').value.trim() || undefined, baseUrl: $('#s-base-url').value.trim() });
    $('#test-result').innerHTML = r.ok
      ? `<span class="text-ok">连接成功：${r.user?.userName || r.user?.name || '未知账号'} · 延迟 ${r.latencyMs}ms · 月度剩余 ${money(r.monthlyRemaining)}</span>`
      : `<span class="text-danger">失败：${r.error}</span>`;
  });
  $('#btn-copy-key').addEventListener('click', async () => {
    const d = await cc.getDiagnostics();
    if (d.credential?.apiKey === undefined && d.credential?.masked) {
      toast('出于安全考虑，复制功能仅在手动模式下可用；自动模式请直接查看 auth.json');
    }
    cc.copyText($('#s-api-key').value || d.credential?.masked || '');
    toast('已复制');
  });
  $('#btn-notify-test').addEventListener('click', () => cc.notifyTest().then(() => toast('已发送测试通知')));
  $('#btn-hotkey').addEventListener('click', async () => {
    const r = await cc.registerHotkey();
    toast(r?.ok ? `快捷键已注册：${r.hotkey}` : '快捷键注册失败（可能被其他程序占用）');
  });
  $('#btn-widget-reset').addEventListener('click', () => cc.widgetAction('resetPosition').then(() => toast('悬浮窗已重置到右上角')));
  $('#btn-widget-toggle').addEventListener('click', () => cc.widgetAction('toggle'));
  $('#btn-reset-settings').addEventListener('click', async () => {
    if (!confirm('确定恢复默认设置？历史数据不会被删除。')) return;
    S.settings = await cc.resetSettings();
    applySettingsToForm();
    applyTheme(S.settings.theme);
    toast('已恢复默认设置');
  });
  $('#btn-diag-copy').addEventListener('click', async () => {
    const d = await cc.getDiagnostics();
    await cc.copyText(JSON.stringify(d, null, 2));
    toast('诊断信息已复制到剪贴板');
  });

  window.addEventListener('resize', () => {
    if (S.tab === 'history') renderHistory();
  });
}

function reportExport(r) {
  toast(r?.ok ? `已导出到 ${r.file}` : r?.canceled ? '已取消导出' : '导出失败');
}

function switchTab(tab) {
  S.tab = tab;
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${tab}`));
  if (tab === 'history') renderHistory();
  if (tab === 'pricing') renderPricing();
  if (tab === 'settings') applySettingsToForm();
  if (tab === 'diagnostics') renderDiagnostics();
}

function applyTheme(theme) {
  const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme || 'dark';
  document.body.dataset.theme = resolved;
  if (S.tab === 'history') renderHistory();
}

async function renderDiagnostics() {
  const d = await cc.getDiagnostics();
  const meta = d.state.meta;
  const info = {
    应用版本: meta.version,
    账号: d.state.snapshot?.account?.userName ?? null,
    套餐: d.state.snapshot?.plan ?? null,
    凭据来源: d.credential?.ok ? d.credential.source : d.credential?.error,
    凭据掩码: d.credential?.masked ?? null,
    登录态文件: d.authFile,
    API: d.state.meta.apiBaseUrl,
    最近延迟ms: d.state.snapshot?.latencyMs ?? null,
    刷新间隔秒: meta.intervalSec,
    下次刷新: meta.nextRefreshAt ? new Date(meta.nextRefreshAt).toLocaleTimeString('zh-CN') : null,
    价目表文件: d.pricingFile,
    价目表生成时间: d.pricingGeneratedAt,
    数据目录: d.userData,
    运行时: d.versions,
    最后错误: meta.lastError,
  };
  $('#diag-info').textContent = JSON.stringify(info, null, 2);
  $('#diag-log').textContent = d.log || '（暂无日志）';
  $('#diag-raw').textContent = JSON.stringify(d.raw, null, 2);
}

function renderStatus() {
  const snap = S.state?.snapshot;
  const meta = S.state?.meta || {};
  $('#status-left').textContent = snap
    ? `5 小时 $${snap.windows.fiveHour.remaining.toFixed(2)} · 每周 $${snap.windows.weekly.remaining.toFixed(2)} · 每月 $${snap.windows.monthly.remaining.toFixed(2)}`
    : '等待数据…';
  $('#status-right').textContent = meta.lastError ? `⚠ ${meta.lastError.message}` : `数据来源 commandcode.ai · v${meta.version ?? ''}`;
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:20px;color:#f88">初始化失败：${err?.stack || err}</pre>`;
});
