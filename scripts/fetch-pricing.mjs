/**
 * fetch-pricing.mjs
 * 抓取 commandcode.ai 官方文档中的 GOAT 套餐价目表 / 窗口限额 / 请求量估算，
 * 解析为结构化 JSON 写入 data/goat-pricing.json。
 *
 *   node scripts/fetch-pricing.mjs            # 联网抓取
 *   node scripts/fetch-pricing.mjs --offline  # 只用本地缓存重新解析
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'data', '.cache');
const OUT = path.join(ROOT, 'data', 'goat-pricing.json');

const SOURCES = {
  goat: 'https://commandcode.ai/docs/plans/goat',
  pricing: 'https://commandcode.ai/docs/resources/pricing-limits',
  models: 'https://commandcode.ai/docs/reference/cli/models',
};

const offline = process.argv.includes('--offline');

/* ------------------------------------------------------------------ utils */

const unescape = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"');

const text = (html) => unescape(html.replace(/<[^>]+>/g, ' ')).replace(/[ \t\u00a0]+/g, ' ').trim();

function money(v) {
  if (v == null) return null;
  const raw = unescape(String(v)).trim();
  if (/^free$/i.test(raw)) return 0;
  if (!/[0-9]/.test(raw)) return null;
  const n = Number(raw.replace(/[$,\s]/g, '').replace(/\+.*$/, ''));
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  if (v == null) return null;
  const raw = String(v).replace(/[,\s]/g, '').split(' ')[0];
  if (/not yet scored|^[-—]+$/i.test(raw) || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/* --------------------------------------------------------------- html bits */

function rowsOf(tableHtml) {
  return [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
}

function cellsOf(rowHtml) {
  return [...rowHtml.matchAll(/<(td|th)\b[\s\S]*?<\/\1>/gi)].map((m) => m[0]);
}

function tablesOf(html) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
}

/* --------------------------------------------------------------- parsers */

/** 主模型表：Model / Context / Intelligence / Tok-s / Input / Output / Cache read / Cache write / Caps */
function parseMainTable(html) {
  const models = [];
  for (const table of tablesOf(html)) {
    const rows = rowsOf(table);
    if (!rows.length) continue;
    const head = cellsOf(rows[0]).map((c) => text(c).toLowerCase()).join('|');
    // 主表独有：带 Cache read / Cache write / Context 列，且没有 Monthly credits 列
    if (!/model/.test(head) || !/input/.test(head) || !/output/.test(head)) continue;
    if (!/cache/.test(head) || /monthly credits/.test(head)) continue;

    for (const row of rows.slice(1)) {
      const cells = cellsOf(row);
      if (cells.length < 6) continue;

      const nameCell = cells[0];
      const anchor = nameCell.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const name = text(anchor ? anchor[2] : nameCell);
      if (!name || /^model$/i.test(name)) continue;
      const slug = anchor ? anchor[1].replace(/^.*\//, '') : null;

      const noteMatch = nameCell.match(/title="([^"]*(?:Off-peak|peak)[^"]*)"/i);
      const plain = cells.map(text);
      const ctx = plain[1];
      const priceText = (i) => {
        const raw = plain[i] || '';
        const extra = raw.match(/\+\s*(\d+)/);
        return { value: money(raw), raw, variants: extra ? Number(extra[1]) : 0 };
      };
      const input = priceText(4);
      const output = priceText(5);
      const cacheRead = priceText(6);
      const cacheWrite = priceText(7);
      const caps = plain[8] || '';

      models.push({
        name,
        slug,
        note: noteMatch ? unescape(noteMatch[1]) : null,
        context: ctx || null,
        contextTokens: ctx ? Number(ctx.replace(/[^0-9.]/g, '')) * (/M$/i.test(ctx) ? 1e6 : /K$/i.test(ctx) ? 1e3 : 1) : null,
        intelligence: /not yet scored/i.test(plain[2] || '') ? null : num(plain[2]),
        tokensPerSecond: num(plain[3]),
        input: input.value,
        output: output.value,
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
        inputVariants: input.variants,
        caps: caps && caps !== '—' ? caps.replace(/^\+\s*/, '') : null,
        free: /free/i.test(plain[4] || ''),
      });
    }
  }
  return models;
}

/** 估算表：Model / Requests per 5 hours / week / month */
function parseEstimateTable(html) {
  const out = [];
  for (const table of tablesOf(html)) {
    const rows = rowsOf(table);
    if (!rows.length) continue;
    const head = cellsOf(rows[0]).map(text).join('|');
    if (!/5 hours/i.test(head)) continue;
    for (const row of rows.slice(1)) {
      const c = cellsOf(row).map(text);
      if (c.length < 4) continue;
      out.push({
        name: c[0],
        requests5h: num(c[1]),
        requestsWeekly: num(c[2]),
        requestsMonthly: num(c[3]),
      });
    }
  }
  return out;
}

/** 价格 + 月度可用额度分档表：Model / Input / Output / Cache Read / Cache Write / Monthly credits */
function parseCreditTierTable(html) {
  const out = [];
  for (const table of tablesOf(html)) {
    const rows = rowsOf(table);
    if (!rows.length) continue;
    const head = cellsOf(rows[0]).map(text).join('|');
    if (!/input/i.test(head) || !/monthly credits/i.test(head)) continue;
    for (const row of rows.slice(1)) {
      const c = cellsOf(row).map(text);
      if (c.length < 6) continue;
      const tiers = [...c[5].matchAll(/\$([0-9.]+)/g)].map((m) => Number(m[1]));
      out.push({
        name: c[0],
        input: money(c[1]),
        output: money(c[2]),
        cacheRead: money(c[3]),
        cacheWrite: money(c[4]),
        creditTiers: tiers,
      });
    }
  }
  return out;
}

/** 从 goat 正文抓窗口限额文案：5-hour limit - $14 of usage */
function parseWindowLimits(plainText) {
  const pick = (re) => {
    const m = plainText.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    fiveHour: pick(/5-hour limit\s*[-–—:]\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
    weekly: pick(/Weekly limit\s*[-–—:]\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
    monthly: pick(/Monthly limit\s*[-–—:]\s*\$?([0-9]+(?:\.[0-9]+)?)/i),
  };
}

function parsePlanMeta(plainText) {
  const m = plainText.match(/\$([0-9]+)\s*of credits/i);
  const price = plainText.match(/for \$([0-9]+(?:\.[0-9]+)?)\s*\/\s*mo/i);
  return {
    name: 'GOAT',
    monthlyPrice: price ? Number(price[1]) : 10,
    monthlyCreditsIncluded: m ? Number(m[1]) : 70,
  };
}

/* ------------------------------------------------------------------ fetch */

async function get(name, useOffline = offline) {
  const file = path.join(CACHE_DIR, `${name}.html`);
  if (useOffline) return fs.readFileSync(file, 'utf8');
  const res = await fetch(SOURCES[name], {
    headers: { 'user-agent': 'Mozilla/5.0 (cc-quota-monitor pricing fetcher)' },
  });
  if (!res.ok) throw new Error(`${SOURCES[name]} -> HTTP ${res.status}`);
  const html = await res.text();
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
  return html;
}

/* ------------------------------------------------------------------- main */

export async function updatePricing({ offline: offlineOverride } = {}) {
  const useOffline = offlineOverride ?? offline;
  const goatHtml = await get('goat', useOffline);
  let modelsHtml = '';
  try {
    modelsHtml = await get('models', useOffline);
  } catch (e) {
    console.warn('models page unavailable:', e.message);
  }

  const goatText = text(goatHtml.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' '))
    .replace(/\s{2,}/g, ' ');

  const models = parseMainTable(goatHtml);
  const estimates = parseEstimateTable(goatHtml);
  const tiers = parseCreditTierTable(goatHtml);

  const estByKey = new Map(estimates.map((e) => [key(e.name), e]));
  const tierByKey = new Map();
  for (const t of tiers) {
    const k = key(t.name);
    if (!tierByKey.has(k) || (t.creditTiers.length > (tierByKey.get(k).creditTiers.length || 0))) tierByKey.set(k, t);
  }

  // 模型 id（来自 Available Models 文档），用于 `cmd --model <id>`
  const idByKey = new Map();
  for (const m of modelsHtml.matchAll(/<code[^>]*>([a-zA-Z0-9][a-zA-Z0-9._:\/-]{2,60})<\/code>/g)) {
    const id = unescape(m[1]);
    if (!/[a-z]/i.test(id)) continue;
    idByKey.set(key(id.split('/').pop()), id);
  }

  for (const m of models) {
    const k = key(m.name);
    const est = estByKey.get(k);
    const tier = tierByKey.get(k);
    if (est) {
      m.requests5h = est.requests5h;
      m.requestsWeekly = est.requestsWeekly;
      m.requestsMonthly = est.requestsMonthly;
    }
    if (tier) {
      m.creditTiers = tier.creditTiers;
      m.input ??= tier.input;
      m.output ??= tier.output;
      m.cacheRead ??= tier.cacheRead;
      m.cacheWrite ??= tier.cacheWrite;
    }
    const id = idByKey.get(k) || idByKey.get(key(m.name.replace(/\s*\(latest\)\s*/i, '')));
    if (id) m.modelId = id;
  }

  const limits = parseWindowLimits(goatText);
  const payload = {
    generatedAt: new Date().toISOString(),
    sources: SOURCES,
    plan: parsePlanMeta(goatText),
    limits: {
      fiveHour: limits.fiveHour ?? 14,
      weekly: limits.weekly ?? 35,
      monthly: limits.monthly ?? 70,
    },
    // 文档估算典型 agent 请求画像（用于把 $ 额度换算成「还能跑多少次」）
    requestProfile: {
      freshInputTokens: 800,
      cacheReadTokens: 50_000,
      outputTokens: [125, 200],
    },
    models,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2), 'utf8');
  const summary = {
    file: OUT,
    generatedAt: payload.generatedAt,
    models: models.length,
    estimates: estimates.length,
    tiers: tiers.length,
    limits: payload.limits,
  };
  console.log(
    `OK -> ${OUT}\n  models=${models.length} estimates=${estimates.length} tiers=${tiers.length} limits=${JSON.stringify(payload.limits)}`
  );
  const missing = models.filter((m) => m.input == null && !m.free);
  if (missing.length) console.warn('  models without input price:', missing.map((m) => m.name).join(', '));
  return summary;
}

// 作为脚本直接执行时才自动运行（被 require/import 时只暴露函数）
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  updatePricing().catch((err) => {
    console.error('pricing fetch failed:', err.message);
    process.exitCode = 1;
  });
}
