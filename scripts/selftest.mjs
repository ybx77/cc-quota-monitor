/**
 * selftest.mjs —— 纯逻辑自检（不需要 Electron、不需要联网、不需要账号）
 * 用于 CI 与贡献者本地快速回归：
 *
 *   node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const { normalizeSnapshot, CommandCodeClient, PLAN_CREDITS } = require('../src/main/api.js');
const pricing = require('../src/main/pricing.js');
const demo = require('../src/main/demo.js');
const { renderAppIcon, renderTrayIcon, encodePng, usageColor } = require('../src/main/png.js');
const { maskKey } = require('../src/main/credentials.js');

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
};

console.log('Command Code Quota Monitor · 自检');

/* ---------------------------------------------------------- API 归一化 */
test('normalizeSnapshot 正确计算三个额度窗口', () => {
  const now = Date.UTC(2026, 0, 15, 12, 0, 0);
  const snap = normalizeSnapshot({
    whoami: { success: true, user: { id: 'u1', userName: 'tester', email: 't@example.com' }, org: null },
    credits: {
      credits: { monthlyCredits: 55, purchasedCredits: 5, freeCredits: 0, belowThreshold: false, creditThreshold: 0 },
      windowLimits: {
        limited: true,
        fiveHour: { used: 3.5, cap: 14, exceeded: false, resetAt: now + 3600_000 },
        weekly: { used: 20, cap: 35, exceeded: false, resetAt: now + 86400_000 },
      },
    },
    subscription: {
      data: { planId: 'individual-goat', status: 'active', currentPeriodEnd: new Date(now + 10 * 86400_000).toISOString() },
    },
    summary: { totalCost: 10, totalCount: 100, totalTokens: 1000, successRate: 100 },
    orgId: null,
    latencyMs: 120,
    errors: [],
    now,
  });

  assert.equal(snap.windows.fiveHour.cap, 14);
  assert.equal(snap.windows.fiveHour.remaining, 10.5);
  assert.equal(snap.windows.fiveHour.usedPct, 25);
  assert.equal(snap.windows.weekly.remaining, 15);
  // 月度口径与官方 Studio 一致：总额度 = max(套餐额度, 剩余月度额度) + 加购 + 赠送
  // 这里 max(70, 55) + 5 + 0 = 75，剩余 55+5+0 = 60，已用 = 75 - 60
  assert.equal(snap.windows.monthly.cap, 75);
  assert.equal(snap.windows.monthly.remaining, 60);
  assert.equal(snap.windows.monthly.used, 15);
  assert.equal(snap.credits.purchasedRemaining, 5);
  assert.equal(snap.plan.name, 'GOAT');
  assert.equal(snap.plan.monthlyCredits, 70);
  assert.equal(snap.windows.fiveHour.resetsInMs, 3600_000);
});

test('normalizeSnapshot 处理接口部分失败（errors 非空且不抛异常）', () => {
  const snap = normalizeSnapshot({
    whoami: { user: { userName: 'x' } },
    credits: null,
    subscription: null,
    summary: null,
    errors: [{ endpoint: '/alpha/billing/credits', status: 500, message: 'boom', friendly: '服务端错误' }],
    now: Date.now(),
  });
  assert.equal(snap.ok, false);
  assert.equal(snap.errors.length, 1);
  assert.equal(snap.windows.fiveHour.cap, 0);
  assert.equal(snap.windows.monthly.remaining, 0);
});

test('套餐额度表覆盖已知 planId', () => {
  assert.equal(PLAN_CREDITS['individual-goat'], 70);
  assert.equal(PLAN_CREDITS['individual-go'], 10);
  assert.equal(PLAN_CREDITS['individual-max'], 150);
});

test('客户端按 Bearer 鉴权拼接 endpoint', async () => {
  const calls = [];
  const client = new CommandCodeClient({ baseUrl: 'https://api.example.com', apiKey: 'k' });
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, auth: init.headers.Authorization });
    return { ok: true, status: 200, text: async () => '{"ok":true}' };
  };
  try {
    await client.whoami();
    await client.credits('org-1');
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(calls[0].url, 'https://api.example.com/alpha/whoami?limits=1');
  assert.equal(calls[0].auth, 'Bearer k');
  assert.equal(calls[1].url, 'https://api.example.com/alpha/billing/credits?orgId=org-1');
});

/* -------------------------------------------------------------- 价目表 */
test('价目表可用且包含 GOAT 主要模型', () => {
  const data = pricing.load();
  assert.ok(data.models.length >= 30, `模型数量异常: ${data.models.length}`);
  assert.equal(data.limits.fiveHour, 14);
  assert.equal(data.limits.weekly, 35);
  assert.equal(data.limits.monthly, 70);
  const names = data.models.map((m) => m.name).join('|');
  assert.match(names, /DeepSeek/);
  assert.match(names, /Gemini|GPT|Qwen|GLM/);
});

test('单次请求成本与"还能跑多少次"计算正确', () => {
  const data = pricing.decorate(pricing.load(), { freshInputTokens: 800, cacheReadTokens: 50000, outputTokens: 175 });
  const model = data.models.find((m) => m.name.includes('DeepSeek V4.1 Flash') && !m.free);
  assert.ok(model, '未找到 DeepSeek V4.1 Flash');
  // 0.15/1M * 800 + 0.003/1M * 50000 + 0.60/1M * 175 = 0.00012 + 0.00015 + 0.000105
  const expected = (800 / 1e6) * 0.15 + (50000 / 1e6) * 0.003 + (175 / 1e6) * 0.6;
  assert.ok(Math.abs(model.perRequest - expected) < 1e-9, `${model.perRequest} != ${expected}`);
  const cap = pricing.capacity(14, model, { freshInputTokens: 800, cacheReadTokens: 50000, outputTokens: 175 });
  assert.equal(cap.requests, Math.floor(14 / expected));
});

test('免费模型成本为 0 且可无限跑', () => {
  const data = pricing.decorate(pricing.load(), {});
  const free = data.models.find((m) => m.free);
  assert.ok(free, '价目表中没有免费模型');
  const cap = pricing.capacity(14, free, {});
  assert.equal(cap.requests, Infinity);
});

/* ------------------------------------------------------------ 演示数据 */
test('演示数据不含任何真实账号特征且结构完整', () => {
  const raw = demo.rawPayloads(Date.now());
  const snap = normalizeSnapshot({ ...raw, latencyMs: 1, errors: [], now: Date.now() });
  assert.equal(snap.account.userName, 'demo-user');
  assert.match(snap.account.email, /@example\.com$/);
  assert.equal(snap.plan.name, 'GOAT');
  assert.equal(snap.windows.monthly.cap, 70);
  const json = JSON.stringify(raw);
  assert.doesNotMatch(json, /apiKey|Bearer|user_[A-Za-z0-9]{20,}/);
});

test('演示历史曲线单调、结尾与实时值吻合', () => {
  const now = Date.now();
  const samples = demo.demoSamples(now);
  assert.ok(samples.length > 100, '样本过少');
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].mo >= samples[i - 1].mo, `第 ${i} 点月度消耗出现回落`);
    assert.ok(samples[i].t > samples[i - 1].t, '时间戳未递增');
  }
  const last = samples.at(-1);
  assert.equal(last.mo, 38.75);
  assert.equal(last.wk, 21.4);
  assert.equal(last.fh, 4.86);
});

/* ------------------------------------------------------------- 图标 */
test('PNG 编码器输出合法文件', () => {
  const png = encodePng(4, 4, Buffer.alloc(64, 128));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 4);
  assert.equal(png.readUInt32BE(20), 4);
});

test('应用图标与托盘图标可生成（含各档配色）', () => {
  const icon = renderAppIcon(64);
  assert.equal(icon.readUInt32BE(16), 64);
  for (const pct of [0, 50, 99, 100]) {
    const tray = renderTrayIcon({ pct, color: usageColor(100 - pct), size: 32 });
    assert.equal(tray.readUInt32BE(16), 32);
    assert.ok(tray.length > 200, '托盘图标内容为空');
  }
});

test('使用率配色分档正确', () => {
  assert.equal(usageColor(10), '#22c55e');
  assert.equal(usageColor(75), '#eab308');
  assert.equal(usageColor(90), '#f97316');
  assert.equal(usageColor(99), '#ef4444');
});

/* ------------------------------------------------------------- 凭据 */
test('API Key 掩码不泄露完整密钥', () => {
  const key = 'user_EXAMPLE0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';
  const masked = maskKey(key);
  assert.ok(!masked.includes(key));
  assert.ok(masked.length < 30);
  assert.match(masked, /^user_EXAMP/);
});

console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败项' : '，全部通过 ✅'}`);
