'use strict';
/** GOAT 价目表：加载 + 单次请求成本 / 剩余额度可跑次数估算 */

const fs = require('node:fs');
const path = require('node:path');

const CANDIDATES = [
  path.join(__dirname, '..', '..', 'data', 'goat-pricing.json'),
  path.join(process.resourcesPath || '', 'data', 'goat-pricing.json'),
];

function load() {
  for (const file of CANDIDATES) {
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      json.file = file;
      return json;
    } catch {
      /* 尝试下一个 */
    }
  }
  return { generatedAt: null, models: [], limits: { fiveHour: 14, weekly: 35, monthly: 70 }, plan: { name: 'GOAT', monthlyPrice: 10, monthlyCreditsIncluded: 70 } };
}

/**
 * 按典型 agent 请求画像估算单次请求成本（美元）
 * cost = Σ (tokens / 1e6) * pricePerMillion
 */
function requestCost(model, profile) {
  const p = {
    freshInputTokens: 800,
    cacheReadTokens: 50000,
    outputTokens: 175,
    cacheWriteTokens: 0,
    ...profile,
  };
  const per = (tokens, price) => (tokens / 1e6) * (Number(price) || 0);
  const input = per(p.freshInputTokens, model.input ?? 0);
  const cacheRead = per(p.cacheReadTokens, model.cacheRead ?? model.input ?? 0);
  const cacheWrite = per(p.cacheWriteTokens, model.cacheWrite ?? 0);
  const output = per(p.outputTokens, model.output ?? 0);
  const total = input + cacheRead + cacheWrite + output;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    total,
    breakdown: { input, cacheRead, cacheWrite, output },
  };
}

/** 给定剩余额度，估算各模型还能跑多少次 */
function capacity(remainingUsd, model, profile) {
  const c = requestCost(model, profile);
  if (!c.total || c.total <= 0) return { ...c, requests: Infinity };
  return { ...c, requests: Math.floor(remainingUsd / c.total) };
}

/** 给价目表补充派生字段 */
function decorate(data, profile) {
  const models = (data.models || []).map((m) => {
    const c = requestCost(m, profile);
    return {
      ...m,
      perRequest: Number(c.total.toFixed(6)),
      perRequestBreakdown: c.breakdown,
      // 官方文档给出的每窗口请求数估算（非免费模型）
      official: m.requests5h
        ? { fiveHour: m.requests5h, weekly: m.requestsWeekly, monthly: m.requestsMonthly }
        : null,
    };
  });
  return { ...data, models };
}

module.exports = { load, requestCost, capacity, decorate };
