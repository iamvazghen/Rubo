import { describe, expect, test } from 'bun:test';
import { EMPTY_TAX_PROFILE } from '../income/tax.js';
import type { Position } from '../tools/portfolio/store.js';
import { computeDrift, proposeRebalance, type Targets, type ValuedHolding } from './engine.js';

const pos = (ticker: string, asset_type: Position['asset_type'], shares: number, avg_cost: number): Position =>
  ({ ticker, asset_type, shares, avg_cost, currency: 'USD', opened: 'x', thesis: 't', conviction: 'med', account: 'traderepublic' });
const held = (p: Position, price: number): ValuedHolding => ({ position: p, price_local: price, base_per_local: 1, base_per_cost: 1, value: p.shares * price });

// $7,000 stock, $3,000 ETF: 70/30 against a 50/50 target.
const holdings = [held(pos('KO', 'stock', 100, 50), 70), held(pos('VT', 'etf', 25, 100), 120)];
const targets: Targets = { mode: 'asset_type', targets: { stock: 50, etf: 50 }, band_pct: 5, min_trade: 50, updated_at: null };
const base = { holdings, reserve: 0, targets, profile: { ...EMPTY_TAX_PROFILE, residence: 'DE' }, allowanceLeft: () => 0, basePerAllowanceUnit: 1.1 };

describe('rebalancing', () => {
  test('drift is measured against the band', () => {
    const { drifts } = computeDrift(holdings, 0, targets);
    expect(drifts.find((d) => d.key === 'stock')).toMatchObject({ weight_pct: 70, drift_pct: 20, outside_band: true });
  });

  test('inside the band: nothing to do', () => {
    const p = proposeRebalance({ ...base, targets: { ...targets, targets: { stock: 68, etf: 32 } }, newCash: 0 });
    expect(p.trades).toEqual([]);
  });

  test('new cash goes to the underweight first, with no sale and no tax', () => {
    const p = proposeRebalance({ ...base, newCash: 4000 });
    expect(p.trades).toEqual([{ side: 'buy', key: 'etf', amount: 4000, funded_by: 'new cash' }]);
    expect(p.est_tax).toBe(0);
  });

  test('without cash the overweight is sold to target, with tax on the gain', () => {
    const p = proposeRebalance({ ...base, newCash: 0 });
    const sell = p.trades.find((t) => t.side === 'sell')!;
    expect(sell).toMatchObject({ ticker: 'KO', amount: 2000, shares: 28.5714 });
    // Gain 28.5714 × (70 - 50) = 571.43; no allowance: × 26.375 % = 150.71
    expect(sell.est_tax).toBeCloseTo(150.71, 1);
    expect(p.trades.find((t) => t.side === 'buy')).toMatchObject({ key: 'etf', amount: 2000, funded_by: 'sales' });
  });

  test('gain is taken in the base currency when cost and quote currencies differ', () => {
    // Bought at 100 EUR (1 EUR = 1.10 USD), quoted at 120 USD: the gain is 10 USD a share, not 20.
    const etf = { ...held(pos('VHYD', 'etf', 100, 100), 120), base_per_cost: 1.1 };
    const p = proposeRebalance({ ...base, holdings: [etf, held(pos('KO', 'stock', 10, 70), 70)], targets: { ...targets, targets: { stock: 50, etf: 50 } }, newCash: 0 });
    const sell = p.trades.find((t) => t.side === 'sell')!;
    // 5,650 sold = 47.0833 shares; gain 470.83; 70 % taxable (fund exemption) = 329.58 x 26.375 % = 86.93
    expect(sell.ticker).toBe('VHYD');
    expect(sell.est_tax).toBeCloseTo(86.93, 1);
  });

  test('no tax residence set: the same sale carries no tax estimate', () => {
    const p = proposeRebalance({ ...base, profile: EMPTY_TAX_PROFILE, newCash: 0 });
    expect(p.trades.find((t) => t.side === 'sell')!.est_tax).toBe(0);
  });

  test('the cash reserve counts as cash when cash has a target', () => {
    const { drifts } = computeDrift(holdings, 1000, { ...targets, targets: { stock: 50, etf: 40, cash: 10 } });
    expect(drifts.find((d) => d.key === 'cash')).toMatchObject({ value: 1000, weight_pct: 9.09 });
  });
});
