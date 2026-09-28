import type { AssetType, Position } from '../tools/portfolio/store.js';
import { capitalGainsTax, type TaxProfile } from '../income/tax.js';

/**
 * Rebalancing maths. Pure: valued holdings and targets in, a trade list out.
 * The model explains the result; it never decides the numbers. Nothing here
 * places an order.
 */

export interface Targets {
  /** Weights are per holding (ticker) or per asset type (stock, etf, bond, cash). */
  mode: 'holding' | 'asset_type';
  targets: Record<string, number>;
  /** Tolerance in percentage points before anything is proposed. */
  band_pct: number;
  min_trade: number;
  updated_at: string | null;
}

export const DEFAULT_TARGETS: Targets = { mode: 'asset_type', targets: {}, band_pct: 5, min_trade: 50, updated_at: null };

export interface ValuedHolding {
  position: Position;
  price_local: number;
  base_per_local: number;
  /** Base currency per unit of the position's cost currency (it can differ from the quote's, e.g. a EUR purchase of a USD-quoted listing). */
  base_per_cost: number;
  value: number;
}

export interface Drift {
  key: string;
  value: number;
  weight_pct: number;
  target_pct: number;
  drift_pct: number;
  outside_band: boolean;
}

export interface Trade {
  side: 'buy' | 'sell';
  key: string;
  ticker?: string;
  /** Base currency. */
  amount: number;
  shares?: number;
  est_tax?: number;
  funded_by?: 'new cash' | 'sales';
}

export interface Proposal {
  total: number;
  drifts: Drift[];
  trades: Trade[];
  est_tax: number;
  notes: string[];
}

const bucketOf = (t: Targets, p: Position): string => (t.mode === 'holding' ? p.ticker : (p.asset_type ?? 'stock') as AssetType);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeDrift(holdings: ValuedHolding[], reserve: number, t: Targets): { total: number; drifts: Drift[] } {
  const values = new Map<string, number>();
  for (const h of holdings) values.set(bucketOf(t, h.position), (values.get(bucketOf(t, h.position)) ?? 0) + h.value);
  // The down-market reserve is cash; it only counts when cash has a target.
  if (t.mode === 'asset_type' && t.targets.cash != null) values.set('cash', (values.get('cash') ?? 0) + reserve);
  const total = [...values.values()].reduce((s, v) => s + v, 0);
  const keys = new Set([...values.keys(), ...Object.keys(t.targets)]);
  const drifts = [...keys].map((key) => {
    const value = values.get(key) ?? 0;
    const weight = total ? (value / total) * 100 : 0;
    const target = t.targets[key] ?? 0;
    return { key, value: round2(value), weight_pct: round2(weight), target_pct: target, drift_pct: round2(weight - target),
      outside_band: Math.abs(weight - target) > t.band_pct };
  });
  return { total, drifts: drifts.sort((a, b) => b.drift_pct - a.drift_pct) };
}

/**
 * Cheapest path back to target: new cash goes to underweights first; only then
 * are overweights sold, largest overweight first, with the owner's tax on the
 * realised gain estimated (average cost; FIFO lots are not tracked).
 */
export function proposeRebalance(p: {
  holdings: ValuedHolding[];
  reserve: number;
  targets: Targets;
  newCash: number;
  profile: TaxProfile;
  allowanceLeft: (account: string) => number;
  basePerAllowanceUnit: number;
}): Proposal {
  const t = p.targets;
  const notes: string[] = [];
  const targetSum = Object.values(t.targets).reduce((s, v) => s + v, 0);
  if (Math.abs(targetSum - 100) > 0.01) notes.push(`targets add up to ${targetSum} %, not 100 % - weights are compared as given`);

  const { total, drifts } = computeDrift(p.holdings, p.reserve, t);
  if (!drifts.some((d) => d.outside_band)) {
    return { total: round2(total), drifts, trades: [], est_tax: 0, notes: [...notes, `everything is within ±${t.band_pct} points of target`] };
  }

  const after = total + p.newCash;
  const gap = new Map(drifts.map((d) => [d.key, (d.target_pct / 100) * after - d.value]));
  const trades: Trade[] = [];

  // 1. New cash to the underweights, in proportion to how far below they are.
  let cash = p.newCash;
  const under = drifts.filter((d) => (gap.get(d.key) ?? 0) > 0);
  const deficit = under.reduce((s, d) => s + gap.get(d.key)!, 0);
  for (const d of under) {
    if (cash <= 0 || deficit <= 0) break;
    const amount = Math.min(gap.get(d.key)!, (p.newCash * gap.get(d.key)!) / deficit);
    if (amount >= t.min_trade) {
      trades.push({ side: 'buy', key: d.key, amount: round2(amount), funded_by: 'new cash' });
      gap.set(d.key, gap.get(d.key)! - amount);
      cash -= amount;
    }
  }

  // 2. Overweights outside the band are sold back to target; the proceeds
  //    fund whatever the new cash did not cover.
  const over = drifts.filter((d) => d.outside_band && (gap.get(d.key) ?? 0) < 0);
  const allowanceUsed = new Map<string, number>();
  let taxTotal = 0;
  let raised = 0;

  for (const d of over) {
    const amount = -gap.get(d.key)!;
    if (amount < t.min_trade) continue;
    // Sell from the biggest holdings in the bucket first.
    let left = amount;
    for (const h of p.holdings.filter((x) => bucketOf(t, x.position) === d.key).sort((a, b) => b.value - a.value)) {
      if (left < t.min_trade) break;
      const amount = Math.min(left, h.value);
      const priceBase = h.price_local * h.base_per_local;
      const shares = Math.floor((amount / priceBase) * 10_000) / 10_000;
      const gain = shares * (h.price_local * h.base_per_local - h.position.avg_cost * h.base_per_cost);
      const account = h.position.account ?? 'default';
      const leftAllowance = p.allowanceLeft(account) - (allowanceUsed.get(account) ?? 0);
      const tax = capitalGainsTax({ gain: gain, assetType: h.position.asset_type, partialExemptionPct: h.position.partial_exemption_pct,
        profile: p.profile, allowanceLeft: leftAllowance, basePerAllowanceUnit: p.basePerAllowanceUnit });
      allowanceUsed.set(account, (allowanceUsed.get(account) ?? 0) + tax.allowance_used / p.basePerAllowanceUnit);
      taxTotal += tax.tax;
      trades.push({ side: 'sell', key: d.key, ticker: h.position.ticker, amount: round2(amount), shares, est_tax: tax.tax });
      left -= amount;
      raised += amount;
    }
  }

  // 3. Spend what the sales raised on what is still under.
  let proceeds = raised;
  for (const [key, g] of [...gap].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])) {
    if (proceeds < t.min_trade) break;
    const amount = Math.min(g, proceeds);
    if (amount < t.min_trade) continue;
    trades.push({ side: 'buy', key, amount: round2(amount), funded_by: 'sales' });
    proceeds -= amount;
  }

  if (trades.some((x) => x.side === 'sell')) notes.push('tax is estimated on average cost; your broker sells the oldest shares first (FIFO), which can differ');
  if (cash >= t.min_trade) notes.push(`${round2(cash)} of new cash is left over`);
  return { total: round2(total), drifts, trades, est_tax: round2(taxTotal), notes };
}
