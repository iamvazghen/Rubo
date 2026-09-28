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
  process.env.TYPESAFE_API_KEY = '';
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
  rate: async (from: string, to: string) => (from === to ? 1 : (({ 'EUR>USD': 1.1, 'USD>EUR': 1 / 1.1 } as any)[`${from}>${to}`] ?? null)),
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

const acct = (o: Partial<{ domestic: boolean; w8ben: boolean; allowance_assigned: number }> = {}) =>
  ({ domestic: false, w8ben: false, allowance_assigned: 0, ...o });
const profileFor = (residence: string | null, options: Record<string, number> = {}) =>
  ({ residence, filing: 'single' as const, options, accounts: {}, confirmed_at: null });

describe('tax on a payment (Germany)', () => {
  const profile = profileFor('DE');
  const pay = async (o: object) => (await mods()).tax.taxOnPayment({ gross: 100, isin: 'US1912161007', account: acct(), profile, allowanceLeft: 0, basePerAllowanceUnit: 1.1, ...o });

  test('US stock at a German broker: 15 % US, then 26.375 % minus the 15 % credit = 10.375 % more', async () => {
    const t = await pay({ account: acct({ domestic: true, w8ben: true }) });
    expect(t.withholding).toBe(15);
    expect(t.residence_tax).toBeCloseTo(10.55, 2); // (100 - 60)/4 = 10 KapESt + 5.5 % Soli
    expect(t.net).toBeCloseTo(74.45, 2);
    expect(t.residence_tax_settled).toBe('at_payment');
    expect(t.residence_tax_label).toBe('German tax');
  });

  test('no W-8BEN means 30 % US withholding', async () => {
    expect((await pay({})).withholding).toBe(30);
  });

  test('foreign broker: cash arrives net of US tax only; German tax is set aside for the return', async () => {
    const t = await pay({ account: acct({ w8ben: true }) });
    expect(t.received).toBe(85);
    expect(t.residence_tax_settled).toBe('with_tax_return');
    expect(t.net).toBeCloseTo(74.45, 2);
  });

  test('the allowance removes German tax up to its size', async () => {
    const t = await pay({ account: acct({ domestic: true, w8ben: true, allowance_assigned: 1000 }), allowanceLeft: 1000 });
    expect(t.residence_tax).toBe(0);
    expect(t.allowance_used).toBe(100);
    expect(t.net).toBe(85);
  });

  test('Irish equity ETF: paid gross, 30 % Teilfreistellung, church tax 8 %', async () => {
    const t = await pay({ isin: 'IE00BK5BQT80', assetType: 'etf', account: acct({ domestic: true }), profile: profileFor('DE', { church_tax_rate: 0.08 }) });
    expect(t.withholding).toBe(0);
    // 70 taxable / 4.08 = 17.157 KapESt; x (1 + 0.055 + 0.08) = 19.47
    expect(t.residence_tax).toBeCloseTo(19.47, 2);
  });
});

describe('tax in other places', () => {
  const pay = async (profile: ReturnType<typeof profileFor>, o: object = {}) =>
    (await mods()).tax.taxOnPayment({ gross: 100, isin: 'US1912161007', account: acct({ w8ben: true }), profile, allowanceLeft: 0, basePerAllowanceUnit: 1, ...o });

  test('Austria: 27.5 % KESt minus the 15 % US credit', async () => {
    const t = await pay(profileFor('AT'), { account: acct({ domestic: true, w8ben: true }) });
    expect(t.residence_tax).toBeCloseTo(12.5, 2);
    expect(t.net).toBeCloseTo(72.5, 2);
    expect(t.residence_tax_label).toBe('Austrian KESt');
  });

  test("a country without built-in rules: the owner's own flat rate, allowance and credit cap", async () => {
    const profile = profileFor('PT', { flat_rate: 0.28, credit_cap_rate: 0.15, allowance: 40 });
    const t = await pay(profile, { allowanceLeft: 40 });
    // 60 taxable x 28 % = 16.8 - 15 credit = 1.8, due with the return.
    expect(t.residence_tax).toBeCloseTo(1.8, 2);
    expect(t.allowance_used).toBe(40);
    expect(t.residence_tax_settled).toBe('with_tax_return');
  });

  test('residence not set: withholding only, and it says so', async () => {
    const t = await pay(profileFor(null));
    expect(t.residence_tax_settled).toBe('not_modelled');
    expect(t.net).toBe(85);
    expect(t.notes.join(' ')).toContain('tax residence not set');
  });

  test('a US resident pays no US withholding on a US stock', async () => {
    expect((await pay(profileFor('US'))).withholding).toBe(0);
  });

  test('a country with no rules and no flat rate is flagged, not guessed', async () => {
    const t = await pay(profileFor('BR'));
    expect(t.residence_tax_settled).toBe('not_modelled');
    expect(t.notes.join(' ')).toContain('no tax rules for BR');
  });
});

describe('accounts, brokers and locale', () => {
  test('broker aliases, and new accounts get defaults without assuming a W-8BEN', async () => {
    const { accountId, defaultAccountTax } = await import('./brokers.js');
    expect(accountId('Trade Republic')).toBe('traderepublic');
    expect(accountId('IB')).toBe('ibkr');
    expect(accountId('My Bank')).toBe('mybank');
    expect(accountId('')).toBe('default');
    expect(defaultAccountTax('traderepublic', 'DE')).toEqual({ broker: 'traderepublic', domestic: true, w8ben: false, allowance_assigned: 0 });
    expect(defaultAccountTax('traderepublic', 'FR').domestic).toBe(false);
    expect(defaultAccountTax('mybank', 'DE').broker).toBeUndefined();
  });

  test('ensureAccounts adds only the new ones', async () => {
    const { store } = await mods();
    expect(store.ensureAccounts(['ibkr', 'degiro'])).toEqual(['ibkr', 'degiro']);
    expect(store.ensureAccounts(['ibkr'])).toEqual([]);
    expect(Object.keys(store.incomeStore.tax().accounts)).toEqual(['ibkr', 'degiro']);
  });

  test('money formats in the base currency, which each owner sets', async () => {
    const { money, baseCurrency, timeZone } = await import('../utils/locale.js');
    const { setSetting } = await import('../utils/config.js');
    expect(baseCurrency()).toBe('USD');
    expect(money(53)).toBe('$53.00');
    setSetting('base_currency', 'eur');
    expect(money(-1.5)).toBe('−€1.50');
    expect(money(10, 'SEK')).toBe('10.00 SEK');
    setSetting('timezone', 'Asia/Tokyo');
    expect(timeZone()).toBe('Asia/Tokyo');
  });

  test('/tax is configured entirely by commands', async () => {
    const { commands, store } = await mods();
    expect(await commands.runIncomeCommand('tax', '', market)).toContain('Tax residence: not set');
    await commands.runIncomeCommand('tax', 'set residence de', market);
    await commands.runIncomeCommand('tax', 'set church_tax_rate 9%', market);
    await commands.runIncomeCommand('tax', 'set Trade-Republic.domestic yes', market);
    await commands.runIncomeCommand('tax', 'set tr.allowance 801', market);
    const shown = await commands.runIncomeCommand('tax', 'set ibkr.w8ben yes', market);
    const t = store.incomeStore.tax();
    expect(t.residence).toBe('DE');
    expect(t.options.church_tax_rate).toBeCloseTo(0.09, 6);
    expect(t.accounts.traderepublic).toMatchObject({ domestic: true, allowance_assigned: 801 });
    expect(t.accounts.ibkr!.w8ben).toBe(true);
    expect(shown).toContain('allowance left €199'); // 1000 - 801 assigned to Trade Republic
    await commands.runIncomeCommand('tax', 'set clear church_tax_rate', market);
    expect(store.incomeStore.tax().options.church_tax_rate).toBeUndefined();
    expect(await commands.runIncomeCommand('tax', 'set residence Germany', market)).toContain('two-letter');
    // Moving abroad: a German broker is no longer domestic.
    await commands.runIncomeCommand('tax', 'set residence AT', market);
    expect(store.incomeStore.tax().accounts.traderepublic!.domestic).toBe(false);
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
    expect(out.reduce((s, a) => s + Math.round(a.amount * 100), 0)).toBe(1001);
    const reinvest = out.find((a) => a.action === 'reinvest')!;
    expect(reinvest.amount).toBe(4);
    expect(reinvest.units).toBe(0.0571);
  });
});

describe('income calendar and reminders', () => {
  test('the announced payment uses the real amount, later ones are projected quarterly', async () => {
    const { cal, store } = await mods();
    const events = await cal.buildIncomeCalendar({
      positions: [{ ticker: 'KO', shares: 100, avg_cost: 55, currency: 'USD', opened: '2024-01-01', thesis: 't', conviction: 'med', isin: 'US1912161007', account: 'traderepublic' }],
      market, profile: { ...profileFor('DE'), accounts: { traderepublic: acct({ domestic: true, w8ben: true, allowance_assigned: 1000 }) } }, ledger: store.incomeStore.ledger(), today: '2026-09-28',
    });
    expect(events[0]).toMatchObject({ id: 'KO:2026-09-15', payDate: '2026-10-01', status: 'announced', gross: 53 });
    expect(events.slice(1).every((e) => e.status === 'estimated')).toBe(true);
    expect(events.map((e) => e.exDate.slice(0, 7))).toEqual(['2026-09', '2026-12', '2027-03', '2027-06']);
    // The €1,000 allowance assigned to this broker covers the first payments entirely.
    expect(events[0]!.tax.residence_tax).toBe(0);
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
    expect(pay[0]!.schedule).toEqual({ kind: 'at', at: '2026-10-01T08:00:00.000Z' }); // 10:00 Europe/Berlin (CEST)
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
    for (const a of ['residence DE', 'traderepublic.domestic yes', 'traderepublic.w8ben yes', 'traderepublic.allowance 1000']) await commands.runIncomeCommand('tax', `set ${a}`, market);
    await refresh.refreshIncome({ market, now: new Date('2026-09-28T08:00:00Z') });
    const reply = await commands.runIncomeCommand('done', 'KO:2026-09-15', market);
    expect(reply).toContain('Recorded KO:2026-09-15');
    // Net $45.05 (53 - 15 % US; German tax covered by the allowance): 30 % reserve = $13.51 + leftover cent.
    expect(store.incomeStore.ledger().reserve).toBeCloseTo(13.52, 2);
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

  test('zonedIso converts the owner wall-clock time in summer and winter', async () => {
    const { refresh } = await mods();
    expect(refresh.zonedIso('2026-07-01', 10)).toBe('2026-07-01T08:00:00.000Z');
    expect(refresh.zonedIso('2026-12-01', 10)).toBe('2026-12-01T09:00:00.000Z');
  });
});

describe('changing the base currency', () => {
  test('recorded amounts are converted at the current rate; with no rate nothing changes', async () => {
    const { store } = await mods();
    const { runFinanceCommand } = await import('../commands/finance.js');
    const { baseCurrency } = await import('../utils/locale.js');
    const entryTax = { gross: 110, withholding: 16.5, received: 93.5, residence_tax: 0, residence_tax_label: 'tax', residence_tax_settled: 'not_modelled' as const, allowance_used: 0, net: 93.5, withholding_rate: 0.15, notes: [] };
    store.incomeStore.saveLedger({ reserve: 110, allowance_used: { ibkr: { year: 2026, amount: 50 } }, entries: [
      { eventId: 'KO:x', ticker: 'KO', confirmedAt: 'x', net: 93.5, tax: entryTax, allocations: [{ action: 'reinvest', pct: 100, amount: 93.5, unit_price: 70, units: 1.3357 }] },
    ] });

    const reply = await runFinanceCommand('setup', 'currency eur', market);
    expect(baseCurrency()).toBe('EUR');
    expect(reply).toContain('reserve now €100.00');
    const l = store.incomeStore.ledger();
    expect(l.entries[0]!.net).toBe(85);
    expect(l.entries[0]!.allocations[0]).toMatchObject({ amount: 85, unit_price: 63.64, units: 1.3357 });
    expect(l.allowance_used.ibkr!.amount).toBe(50); // kept in the jurisdiction's currency

    expect(await runFinanceCommand('setup', 'currency JPY', market)).toContain('nothing was changed');
    expect(baseCurrency()).toBe('EUR');
  });
});

describe('the cash reserve', () => {
  test('owner additions and uses are dated; the reserve cannot go below zero', async () => {
    const { commands, store } = await mods();
    store.incomeStore.saveLedger({ reserve: 100, allowance_used: {}, entries: [] });
    expect(await commands.runIncomeCommand('reserve', 'add 250 monthly top-up', market)).toContain('$350.00');
    expect(await commands.runIncomeCommand('reserve', 'use 500', market)).toContain('more than that');
    const shown = await commands.runIncomeCommand('reserve', 'use 300 bought VWCE in the dip', market);
    expect(shown).toContain('Cash reserve for down markets: $50.00');
    expect(shown).toContain('−$300.00 bought VWCE in the dip');
    expect(shown).toContain('+$250.00 monthly top-up');
    const moves = store.incomeStore.ledger().reserve_moves!;
    expect(moves.map((m) => m.amount)).toEqual([250, -300]);
    expect(moves[0]!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await commands.runIncomeCommand('reserve', 'add abc', market)).toContain('Use /reserve add <amount>');
  });
});
