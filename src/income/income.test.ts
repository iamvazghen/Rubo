import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MarketData } from '../market/yahoo.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rubo-income-'));
  process.env.RUBO_HOME = home;
  process.env.RUBO_TIMEZONE = 'Europe/Berlin';
  delete process.env.TYPESAFE_API_KEY;
});
afterEach(() => {
  delete process.env.RUBO_HOME;
  delete process.env.RUBO_TIMEZONE;
  rmSync(home, { recursive: true, force: true });
});

/** Fixed market: KO pays $0.53 quarterly (ex 2026-09-15, pay 2026-10-01); EUR = 1.10 USD. */
const market: MarketData = {
  quote: async (s) => ({ KO: { price: 70, currency: 'USD' }, VWCE: { price: 130, currency: 'EUR' } } as any)[s] ?? null,
  dividendHistory: async (s) =>
    s === 'KO'
      ? { currency: 'USD', instrumentType: 'EQUITY', dividends: ['2025-09-15', '2025-12-01', '2026-03-14', '2026-06-13', '2026-09-15'].map((d) => ({ exDate: d, amount: 0.53 })) }
      : s === 'VWCE' ? { currency: 'EUR', instrumentType: 'ETF', dividends: [] } : null,
  dividendCalendar: async (s) => (s === 'KO' ? { exDate: '2026-09-15', payDate: '2026-10-01', annualRate: 2.12 } : null),
  usdPerUnit: async (c) => ({ USD: 1, EUR: 1.1 } as any)[c] ?? null,
  searchIsin: async () => [],
  fundamentals: async () => null,
};

const mods = async () => ({
  tax: await import('./tax.js'),
  plan: await import('./plan.js'),
  cal: await import('./calendar.js'),
  store: await import('./store.js'),
  refresh: await import('./refresh.js'),
  commands: await import('./commands.js'),
  portfolio: await import('../tools/portfolio/store.js'),
  cron: await import('../cron/store.js'),
});

describe('tax on a payment (Germany)', () => {
  const profile = { residence: 'DE', filing: 'single' as const, church_tax_rate: 0, accounts: {}, confirmed_at: null };

  test('US stock at a German broker: 15 % US, then 26.375 % minus the 15 % credit = 10.375 % more', async () => {
    const { tax } = await mods();
    const t = tax.taxOnPayment({ gross_usd: 100, isin: 'US1912161007', account: { domestic: true, w8ben: true, exemption_order_eur: 0 }, profile, allowanceLeftEur: 0, usdPerEur: 1.1 });
    expect(t.withholding_usd).toBe(15);
    expect(t.residence_tax_usd).toBeCloseTo(10.55, 2); // (100 - 60)/4 = 10 KapESt + 5.5 % Soli
    expect(t.net_usd).toBeCloseTo(74.45, 2);
    expect(t.residence_tax_settled).toBe('at_payment');
  });

  test('no W-8BEN means 30 % US withholding', async () => {
    const { tax } = await mods();
    const t = tax.taxOnPayment({ gross_usd: 100, isin: 'US1912161007', account: { domestic: false, w8ben: false, exemption_order_eur: 0 }, profile, allowanceLeftEur: 0, usdPerEur: 1.1 });
    expect(t.withholding_usd).toBe(30);
  });

  test('foreign broker: cash arrives net of US tax only; German tax is set aside for the return', async () => {
    const { tax } = await mods();
    const t = tax.taxOnPayment({ gross_usd: 100, isin: 'US1912161007', account: { domestic: false, w8ben: true, exemption_order_eur: 0 }, profile, allowanceLeftEur: 0, usdPerEur: 1.1 });
    expect(t.received_usd).toBe(85);
    expect(t.residence_tax_settled).toBe('with_tax_return');
    expect(t.net_usd).toBeCloseTo(74.45, 2);
  });

  test('the allowance removes German tax up to its size', async () => {
    const { tax } = await mods();
    const t = tax.taxOnPayment({ gross_usd: 100, isin: 'US1912161007', account: { domestic: true, w8ben: true, exemption_order_eur: 1000 }, profile, allowanceLeftEur: 1000, usdPerEur: 1.1 });
    expect(t.residence_tax_usd).toBe(0);
    expect(t.allowance_used_usd).toBe(100);
    expect(t.net_usd).toBe(85);
  });

  test('Irish equity ETF: paid gross, 30 % Teilfreistellung, church tax 8 %', async () => {
    const { tax } = await mods();
    const t = tax.taxOnPayment({ gross_usd: 100, isin: 'IE00BK5BQT80', assetType: 'etf', account: { domestic: true, w8ben: true, exemption_order_eur: 0 },
      profile: { ...profile, church_tax_rate: 0.08 }, allowanceLeftEur: 0, usdPerEur: 1.1 });
    expect(t.withholding_usd).toBe(0);
    // 70 taxable / 4.08 = 17.157 KapESt; × (1 + 0.055 + 0.08) = 19.47
    expect(t.residence_tax_usd).toBeCloseTo(19.47, 2);
  });
});

describe('yield plan', () => {
  test('default is 40/30/20/10 and parses and validates owner input', async () => {
    const { plan } = await mods();
    expect(plan.validatePlan(plan.DEFAULT_YIELD_PLAN.default)).toBeNull();
    expect(plan.parsePlanSpec('reinvest 50 reserve 50')).toEqual([{ action: 'reinvest', pct: 50 }, { action: 'reserve', pct: 50 }]);
    expect(plan.parsePlanSpec('withdraw 60 repurpose 40 VWCE')).toEqual([{ action: 'withdraw', pct: 60 }, { action: 'repurpose', pct: 40, target: 'VWCE' }]);
    expect(typeof plan.parsePlanSpec('reinvest 50 reserve 40')).toBe('string'); // 90 %
  });

  test('allocation never loses a cent and prices reinvestment', async () => {
    const { plan } = await mods();
    const out = plan.allocate(10.01, plan.DEFAULT_YIELD_PLAN.default, () => 70);
    expect(out.reduce((s, a) => s + Math.round(a.usd * 100), 0)).toBe(1001);
    const reinvest = out.find((a) => a.action === 'reinvest')!;
    expect(reinvest.usd).toBe(4);
    expect(reinvest.units).toBe(0.0571);
  });
});

describe('income calendar and reminders', () => {
  test('the announced payment uses the real amount, later ones are projected quarterly', async () => {
    const { cal, tax, store } = await mods();
    const events = await cal.buildIncomeCalendar({
      positions: [{ ticker: 'KO', shares: 100, avg_cost: 55, currency: 'USD', opened: '2024-01-01', thesis: 't', conviction: 'med', isin: 'US1912161007', account: 'traderepublic' }],
      market, profile: tax.DEFAULT_TAX_PROFILE, ledger: store.incomeStore.ledger(), today: '2026-09-28',
    });
    expect(events[0]).toMatchObject({ id: 'KO:2026-09-15', payDate: '2026-10-01', status: 'announced', gross_usd: 53 });
    expect(events.slice(1).every((e) => e.status === 'estimated')).toBe(true);
    expect(events.map((e) => e.exDate.slice(0, 7))).toEqual(['2026-09', '2026-12', '2027-03', '2027-06']);
    // Trade Republic's €1,000 exemption order covers the first payments entirely.
    expect(events[0]!.tax.residence_tax_usd).toBe(0);
  });

  test('accumulating funds produce no events; bonds use the coupon terms', async () => {
    const { cal } = await mods();
    const none = await cal.eventsForPosition({ ticker: 'VWCE', shares: 10, avg_cost: 100, currency: 'EUR', opened: 'x', thesis: 't', conviction: 'med', asset_type: 'etf' }, market, '2026-09-28');
    expect(none).toEqual([]);
    const bond = await cal.eventsForPosition({ ticker: 'BUND', shares: 1, avg_cost: 98, currency: 'EUR', opened: 'x', thesis: 't', conviction: 'med',
      asset_type: 'bond', face_value: 10_000, coupon_rate_pct: 2.5, coupon_frequency: 1, next_coupon_date: '2027-02-15' }, market, '2026-09-28');
    expect(bond).toHaveLength(1);
    expect(bond[0]).toMatchObject({ kind: 'coupon', payDate: '2027-02-15', perShare: 250 });
  });

  test('refresh schedules each reminder once, sent verbatim, and never deletes itself', async () => {
    const { refresh, portfolio, cron } = await mods();
    new portfolio.PortfolioStore().write({ version: 1, updated: '', positions: [
      { ticker: 'KO', shares: 100, avg_cost: 55, currency: 'USD', opened: '2024-01-01', thesis: 't', conviction: 'med', isin: 'US1912161007', account: 'traderepublic' },
    ], closed: [], journal: [], notes: [] });
    refresh.ensureIncomeRefreshJob();
    const now = new Date('2026-09-28T08:00:00Z');
    await refresh.refreshIncome({ market, now });
    await refresh.refreshIncome({ market, now }); // idempotent
    const jobs = cron.loadCronStore().jobs;
    const pay = jobs.filter((j) => j.name === 'income:KO:2026-09-15:pay');
    expect(pay).toHaveLength(1);
    expect(pay[0]!.payload.direct).toBe(true);
    expect(pay[0]!.schedule).toEqual({ kind: 'at', at: '2026-10-01T08:00:00.000Z' }); // 10:00 in Köln (CEST)
    expect(pay[0]!.payload.message).toContain('$53.00 gross');
    expect(pay[0]!.payload.message).toContain('40 % reinvest');
    expect(jobs.some((j) => j.name === 'income:refresh')).toBe(true);
    // Ex-date already passed: no "hold through" reminder for this one.
    expect(jobs.some((j) => j.name === 'income:KO:2026-09-15:ex')).toBe(false);
  });

  test('/done records the payment: reserve grows, reinvested shares are added at the right average cost', async () => {
    const { refresh, portfolio, commands, store } = await mods();
    new portfolio.PortfolioStore().write({ version: 1, updated: '', positions: [
      { ticker: 'KO', shares: 100, avg_cost: 55, currency: 'USD', opened: '2024-01-01', thesis: 't', conviction: 'med', isin: 'US1912161007', account: 'traderepublic' },
    ], closed: [], journal: [], notes: [] });
    await refresh.refreshIncome({ market, now: new Date('2026-09-28T08:00:00Z') });
    const reply = await commands.runIncomeCommand('done', 'KO:2026-09-15', market);
    expect(reply).toContain('Recorded KO:2026-09-15');
    // Net $45.05 (53 - 15 % US; German tax covered by the allowance): 30 % reserve = $13.51 + leftover cent.
    expect(store.incomeStore.ledger().reserve_usd).toBeCloseTo(13.52, 2);
    const ko = new portfolio.PortfolioStore().read().positions[0]!;
    expect(ko.shares).toBeCloseTo(100.2574, 4); // $18.02 / $70
    expect(ko.avg_cost).toBeLessThan(55.1);
    expect(await commands.runIncomeCommand('done', 'KO:2026-09-15', market)).toContain('already recorded');
  });

  test('/yieldplan set changes the default and per-holding plans', async () => {
    const { commands, store } = await mods();
    expect(await commands.runIncomeCommand('yieldplan', 'set reinvest 100', market)).toContain('Saved');
    expect(await commands.runIncomeCommand('yieldplan', 'set KO withdraw 100', market)).toContain('Saved for KO');
    const plan = store.incomeStore.plan();
    expect(plan.default).toEqual([{ action: 'reinvest', pct: 100 }]);
    expect(plan.overrides.KO).toEqual([{ action: 'withdraw', pct: 100 }]);
    expect(await commands.runIncomeCommand('yieldplan', 'set reinvest 50', market)).toContain('Not saved');
  });

  test('zonedIso converts Köln wall-clock time in summer and winter', async () => {
    const { refresh } = await mods();
    expect(refresh.zonedIso('2026-07-01', 10)).toBe('2026-07-01T08:00:00.000Z');
    expect(refresh.zonedIso('2026-12-01', 10)).toBe('2026-12-01T09:00:00.000Z');
  });
});
