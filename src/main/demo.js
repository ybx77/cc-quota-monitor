'use strict';
/**
 * 演示数据（--demo）
 * 用于生成 README 截图 / 无需账号即可体验界面。
 * 全部为合成数据：账号、额度、消费都指向 demo 占位值，不含任何真实账号信息。
 * 走的是与线上一致的数据结构 → normalizeSnapshot()，因此演示模式下界面逻辑完全真实。
 */

const DEMO_USER_ID = '00000000-0000-0000-0000-000000000000';

/** 生成一份与官方接口同构的原始响应 */
function rawPayloads(now = Date.now()) {
  const fiveHourReset = now + 2.4 * 3600 * 1000;
  const weeklyReset = now + 3.3 * 86400 * 1000;
  const periodStart = now - 18.6 * 86400 * 1000;
  const periodEnd = now + 12.4 * 86400 * 1000;

  return {
    whoami: {
      success: true,
      user: { id: DEMO_USER_ID, name: 'Demo User', email: 'demo@example.com', userName: 'demo-user' },
      org: null,
    },
    credits: {
      credits: { belowThreshold: false, creditThreshold: 0, monthlyCredits: 31.25, purchasedCredits: 0, freeCredits: 0 },
      windowLimits: {
        limited: true,
        exceeded: null,
        fiveHour: { used: 4.86, cap: 14, exceeded: false, resetAt: fiveHourReset },
        weekly: { used: 21.4, cap: 35, exceeded: false, resetAt: weeklyReset },
      },
    },
    subscription: {
      success: true,
      data: {
        id: 'sub_demo_000000000000',
        status: 'active',
        userId: DEMO_USER_ID,
        orgId: null,
        createdAt: new Date(periodStart).toISOString(),
        priceId: 'price_demo_000000000000',
        metadata: { commandCode: 'true', commandCodeUserId: DEMO_USER_ID },
        quantity: 1,
        cancelAtPeriodEnd: false,
        currentPeriodStart: new Date(periodStart).toISOString(),
        currentPeriodEnd: new Date(periodEnd).toISOString(),
        endedAt: null,
        cancelAt: null,
        canceledAt: null,
        planId: 'individual-goat',
        pendingPhase: null,
      },
    },
    summary: {
      totalCount: 12480,
      totalCost: 38.75,
      averageCost: 0.003105,
      successRate: 99.4,
      completedCount: 12405,
      failedCount: 75,
      totalTokensIn: 1_482_000_000,
      totalTokensOut: 12_400_000,
      totalTokens: 1_494_400_000,
      totalCredits: 38.75,
      totalFreeCredits: 0,
      totalMonthlyCredits: 38.75,
      totalPurchasedCredits: 0,
      periodBasis: 'billing-period',
    },
    orgId: null,
  };
}

/** 合成 24 小时采样历史，让曲线与速率预测看起来是活的 */
function demoSamples(now = Date.now(), hours = 24) {
  const samples = [];
  const fiveHourReset = now + 2.4 * 3600 * 1000;
  const weeklyReset = now + 3.3 * 86400 * 1000;
  const periodEnd = now + 12.4 * 86400 * 1000;
  const stepMs = 5 * 60 * 1000;
  const points = Math.floor((hours * 3600 * 1000) / stepMs);

  // 消耗速率随时间衰减：rate(u) = 0.28 + 1.15·e^(-u/2.8)  （u = 距现在小时数）
  // 已用(u) = 当前值 − ∫rate，因此最新采样点与实时快照完全吻合（保证速率推算为正）
  const spent = (u) => 0.28 * u + 1.15 * 2.8 * (1 - Math.exp(-u / 2.8));

  for (let i = points; i >= 0; i--) {
    const t = now - i * stepMs;
    const u = i * (stepMs / 3600 / 1000);
    const delta = spent(u);
    const monthlyUsed = Math.max(0, 38.75 - delta);
    const weeklyUsed = Math.max(0, 21.4 - delta * 0.92);
    const fiveHourUsed = Math.max(0, 4.86 - Math.min(u, 4.9) * 1.05);
    samples.push({
      t,
      fh: Number(fiveHourUsed.toFixed(4)),
      wk: Number(weeklyUsed.toFixed(4)),
      mo: Number(monthlyUsed.toFixed(4)),
      fhCap: 14,
      wkCap: 35,
      moCap: 70,
      cost: Number((monthlyUsed + 0.6).toFixed(2)),
      req: Math.round(12480 - u * 26),
      tok: Math.round(1_494_400_000 - u * 26 * 119_000),
      fhReset: fiveHourReset,
      wkReset: weeklyReset,
      moReset: periodEnd,
    });
  }
  return samples;
}

module.exports = { rawPayloads, demoSamples, DEMO_USER_ID };
