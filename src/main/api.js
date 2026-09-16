'use strict';
/**
 * Command Code (commandcode.ai) 用量 API 客户端。
 *
 * 已逆向确认的接口（Base: https://api.commandcode.ai，鉴权: Authorization: Bearer <apiKey>）：
 *   GET /alpha/whoami?limits=1                -> 账号 / 组织 / 组织限额
 *   GET /alpha/billing/credits?orgId=         -> 月度剩余额度 + 5 小时 / 每周窗口限额
 *   GET /alpha/billing/subscriptions?orgId=   -> 订阅（planId / 周期 / 状态）
 *   GET /alpha/usage/summary?orgId=&since=    -> 当前计费周期的请求数 / 成本 / token
 */

const DEFAULT_BASE = 'https://api.commandcode.ai';
const DEFAULT_TIMEOUT = 20000;

/** 套餐月度额度（与 CLI 内置表一致，来自 harness 的 credits 表） */
const PLAN_CREDITS = {
  'individual-go': 10,
  'individual-goat': 70,
  'individual-pro': 30,
  'individual-pro-v1': 80,
  'individual-provider': 15,
  'individual-max': 150,
  'individual-ultra': 300,
  'teams-pro': 40,
};

const PLAN_NAMES = {
  'individual-go': 'Go',
  'individual-goat': 'GOAT',
  'individual-pro': 'Pro',
  'individual-pro-v1': 'Pro',
  'individual-provider': 'Provider',
  'individual-max': 'Max',
  'individual-ultra': 'Ultra',
  'teams-pro': 'Teams Pro',
};

class ApiError extends Error {
  constructor(message, { status = 0, body = null, endpoint = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
    this.friendly = ApiError.friendly(message, status);
  }

  static friendly(message, status) {
    if (status === 401 || status === 403) return 'API Key 无效或已过期，请在设置中重新登录 / 更新 Key';
    if (status === 402) return '额度不足或订阅未激活';
    if (status === 404) return '接口不存在（可能平台接口已变更）';
    if (status === 429) return '请求过于频繁，已被限流，稍后自动重试';
    if (status >= 500) return 'Command Code 服务端错误，稍后自动重试';
    if (/abort|timeout/i.test(message)) return '请求超时，请检查网络或代理';
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|network/i.test(message)) return '网络不可达，请检查网络或代理设置';
    return message;
  }
}

function joinUrl(base, endpoint, params) {
  const url = new URL(endpoint.replace(/^\//, ''), base.endsWith('/') ? base : `${base}/`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

class CommandCodeClient {
  constructor({ baseUrl = DEFAULT_BASE, apiKey, timeout = DEFAULT_TIMEOUT } = {}) {
    this.baseUrl = (baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeout = timeout;
    this.lastLatencyMs = null;
  }

  async get(endpoint, params, { signal } = {}) {
    if (!this.apiKey) throw new ApiError('缺少 API Key', { status: 401, endpoint });
    const url = joinUrl(this.baseUrl, endpoint, params);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
    const started = Date.now();
    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'cc-quota-monitor/1.0',
        },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new ApiError(err.message, { endpoint });
    }
    clearTimeout(timer);
    this.lastLatencyMs = Date.now() - started;

    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 800) };
    }
    if (!res.ok) {
      throw new ApiError(`HTTP ${res.status} ${endpoint}`, { status: res.status, body, endpoint });
    }
    return { data: body, latencyMs: this.lastLatencyMs, endpoint, url };
  }

  whoami() {
    return this.get('/alpha/whoami', { limits: 1 });
  }

  credits(orgId) {
    return this.get('/alpha/billing/credits', { orgId });
  }

  subscription(orgId) {
    return this.get('/alpha/billing/subscriptions', { orgId });
  }

  summary({ orgId, since } = {}) {
    return this.get('/alpha/usage/summary', { orgId, since });
  }

  /** 一次拉全所有面板数据，返回归一化快照 */
  async snapshot({ now = Date.now() } = {}) {
    const who = await this.whoami();
    const orgId = who?.data?.org?.id ?? null;

    const [creditsRes, subRes] = await Promise.all([
      this.credits(orgId).catch((e) => ({ error: e })),
      this.subscription(orgId).catch((e) => ({ error: e })),
    ]);

    const periodStart = subRes?.data?.data?.currentPeriodStart ?? null;
    const summaryRes = await this.summary({ orgId, since: periodStart }).catch((e) => ({ error: e }));

    const errors = [creditsRes.error, subRes.error, summaryRes.error].filter(Boolean).map((e) => ({
      endpoint: e.endpoint,
      status: e.status,
      message: e.message,
      friendly: e.friendly,
    }));

    return normalizeSnapshot({
      whoami: who?.data ?? null,
      credits: creditsRes?.data ?? null,
      subscription: subRes?.data ?? null,
      summary: summaryRes?.data ?? null,
      orgId,
      latencyMs: who?.latencyMs ?? null,
      errors,
      now,
    });
  }
}

/* ------------------------------------------------------------ normalize */

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function makeWindow({ label, key, used, cap, resetAt, exceeded, now }) {
  const u = Math.max(0, finite(used));
  const c = Math.max(0, finite(cap));
  const remaining = Math.max(0, c - u);
  const usedPct = c > 0 ? clamp((u / c) * 100, 0, 100) : 0;
  const resetMs = Number.isFinite(Number(resetAt)) ? Number(resetAt) : null;
  return {
    key,
    label,
    used: round(u, 4),
    cap: round(c, 4),
    remaining: round(remaining, 4),
    usedPct: round(usedPct, 2),
    remainingPct: round(100 - usedPct, 2),
    resetAt: resetMs,
    resetsInMs: resetMs ? Math.max(0, resetMs - now) : null,
    exceeded: Boolean(exceeded),
    windowMs: WINDOW_MS[key] ?? null,
    elapsedPct: resetMs && WINDOW_MS[key] ? round(clamp((1 - (resetMs - now) / WINDOW_MS[key]) * 100, 0, 100), 2) : null,
  };
}

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

const WINDOW_MS = {
  fiveHour: 5 * 3600 * 1000,
  weekly: 7 * 24 * 3600 * 1000,
};

function normalizeSnapshot({ whoami, credits, subscription, summary, orgId, latencyMs, errors, now }) {
  const sub = subscription?.data ?? null;
  const planId = sub?.planId ?? credits?.credits?.planId ?? null;
  const planKey = planId ? String(planId).toLowerCase().replace(/_/g, '-') : null;
  const planCredits = planKey ? PLAN_CREDITS[planKey] ?? null : null;

  const c = credits?.credits ?? null;
  const monthlyRemaining = Math.max(0, finite(c?.monthlyCredits));
  const purchasedRemaining = Math.max(0, finite(c?.purchasedCredits));
  const freeRemaining = Math.max(0, finite(c?.freeCredits));
  const totalRemaining = monthlyRemaining + purchasedRemaining + freeRemaining;

  const totalSpent = Math.max(0, finite(summary?.totalCost));
  const activePool = sub?.status === 'active' && planCredits ? planCredits : null;
  const totalPool = activePool != null ? Math.max(activePool, monthlyRemaining) + purchasedRemaining + freeRemaining : totalRemaining + totalSpent;
  const monthlyUsed = Math.max(0, totalPool - totalRemaining);
  const periodEnd = sub?.currentPeriodEnd ? Date.parse(sub.currentPeriodEnd) : null;

  const wl = credits?.windowLimits ?? null;
  const windows = {
    fiveHour: makeWindow({
      label: '5 小时限制',
      key: 'fiveHour',
      used: wl?.fiveHour?.used,
      cap: wl?.fiveHour?.cap,
      resetAt: wl?.fiveHour?.resetAt,
      exceeded: wl?.fiveHour?.exceeded,
      now,
    }),
    weekly: makeWindow({
      label: '每周限制 (Weekly)',
      key: 'weekly',
      used: wl?.weekly?.used,
      cap: wl?.weekly?.cap,
      resetAt: wl?.weekly?.resetAt,
      exceeded: wl?.weekly?.exceeded,
      now,
    }),
    monthly: makeWindow({
      label: '每月限制 (Monthly)',
      key: 'monthly',
      used: monthlyUsed,
      cap: totalPool,
      resetAt: periodEnd && Number.isFinite(periodEnd) ? periodEnd : null,
      exceeded: monthlyRemaining <= 0 && totalPool > 0,
      now,
    }),
  };

  return {
    ok: errors.length === 0,
    fetchedAt: new Date(now).toISOString(),
    latencyMs,
    errors,
    account: {
      userId: whoami?.user?.id ?? sub?.userId ?? null,
      userName: whoami?.user?.userName ?? whoami?.user?.name ?? null,
      name: whoami?.user?.name ?? null,
      email: whoami?.user?.email ?? null,
      orgId: orgId ?? whoami?.org?.id ?? null,
      orgName: whoami?.org?.name ?? null,
      orgLogin: whoami?.org?.login ?? null,
    },
    plan: {
      planId,
      name: planKey ? PLAN_NAMES[planKey] ?? planKey : null,
      status: sub?.status ?? null,
      monthlyCredits: planCredits,
      cancelAtPeriodEnd: Boolean(sub?.cancelAtPeriodEnd),
      currentPeriodStart: sub?.currentPeriodStart ?? null,
      currentPeriodEnd: sub?.currentPeriodEnd ?? null,
      periodDaysLeft: periodEnd && Number.isFinite(periodEnd) ? Math.max(0, Math.ceil((periodEnd - now) / 86400000)) : null,
      subscriptionId: sub?.id ?? null,
    },
    credits: {
      monthlyRemaining: round(monthlyRemaining, 2),
      purchasedRemaining: round(purchasedRemaining, 2),
      freeRemaining: round(freeRemaining, 2),
      totalRemaining: round(totalRemaining, 2),
      totalSpent: round(totalSpent, 2),
      totalPool: round(totalPool, 2),
      belowThreshold: Boolean(c?.belowThreshold),
      creditThreshold: finite(c?.creditThreshold),
    },
    windows,
    windowLimits: {
      limited: Boolean(wl?.limited),
      exceeded: wl?.exceeded ?? null,
    },
    periodUsage: summary
      ? {
          totalCount: finite(summary.totalCount),
          totalCost: round(finite(summary.totalCost), 2),
          averageCost: finite(summary.averageCost),
          successRate: finite(summary.successRate),
          completedCount: finite(summary.completedCount),
          failedCount: finite(summary.failedCount),
          totalTokensIn: finite(summary.totalTokensIn),
          totalTokensOut: finite(summary.totalTokensOut),
          totalTokens: finite(summary.totalTokens),
          periodBasis: summary.periodBasis ?? null,
        }
      : null,
    orgLimits: whoami?.orgLimits ?? [],
    raw: { whoami, credits, subscription, summary },
  };
}

module.exports = {
  CommandCodeClient,
  ApiError,
  PLAN_CREDITS,
  PLAN_NAMES,
  normalizeSnapshot,
  DEFAULT_BASE,
};
