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
  min_trade_usd: number;
  updated_at: string | null;
}

export const DEFAULT_TARGETS: Targets = { mode: 'asset_type', targets: {}, band_pct: 5, min_trade_usd: 50, updated_at: null };

export interface ValuedHolding {
  position: Position;
  price_local: number;
  usd_per_local: number;
  value_usd: number;
}

export interface Drift {
  key: string;
  value_usd: number;
  weight_pct: number;
  target_pct: number;
  drift_pct: number;
  outside_band: boolean;
}

export interface Trade {
  side: 'buy' | 'sell';
  key: string;
  ticker?: string;
  usd: number;
  shares?: number;
  est_tax_usd?: number;
  funded_by?: 'new cash' | 'sales';
}

export interface Proposal {
  total_usd: number;
  drifts: Drift[];
  trades: Trade[];
  est_tax_usd: number;
  notes: string[];
}

const bucketOf = (t: Targets, p: Position): string => (t.mode === 'holding' ? p.ticker : (p.asset_type ?? 'stock') as AssetType);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeDrift(holdings: ValuedHolding[], reserveUsd: number, t: Targets): { total: number; drifts: Drift[] } {
  const values = new Map<string, number>();
  for (const h of holdings) values.set(bucketOf(t, h.position), (values.get(bucketOf(t, h.position)) ?? 0) + h.value_usd);
  // The down-market reserve is cash; it only counts when cash has a target.
  if (t.mode === 'asset_type' && t.targets.cash != null) values.set('cash', (values.get('cash') ?? 0) + reserveUsd);
  const total = [...values.values()].reduce((s, v) => s + v, 0);
  const keys = new Set([...values.keys(), ...Object.keys(t.targets)]);
  const drifts = [...keys].map((key) => {
    const value = values.get(key) ?? 0;
    const weight = total ? (value / total) * 100 : 0;
    const target = t.targets[key] ?? 0;
    return { key, value_usd: round2(value), weight_pct: round2(weight), target_pct: target, drift_pct: round2(weight - target),
      outside_band: Math.abs(weight - target) > t.band_pct };
  });
  return { total, drifts: drifts.sort((a, b) => b.drift_pct - a.drift_pct) };
}

/**
 * Cheapest path back to target: new cash goes to underweights first; only then
 * are overweights sold, largest overweight first, with the German tax on the
 * realised gain estimated (average cost; FIFO lots are not tracked).
 */
export function proposeRebalance(p: {
  holdings: ValuedHolding[];
  reserveUsd: number;
  targets: Targets;
  newCashUsd: number;
  profile: TaxProfile;
  allowanceLeftEur: (account: string) => number;
  usdPerEur: number;
}): Proposal {
  const t = p.targets;
  const notes: string[] = [];
  const targetSum = Object.values(t.targets).reduce((s, v) => s + v, 0);
  if (Math.abs(targetSum - 100) > 0.01) notes.push(`targets add up to ${targetSum} %, not 100 % - weights are compared as given`);

  const { total, drifts } = computeDrift(p.holdings, p.reserveUsd, t);
  if (!drifts.some((d) => d.outside_band)) {
    return { total_usd: round2(total), drifts, trades: [], est_tax_usd: 0, notes: [...notes, `everything is within ±${t.band_pct} points of target`] };
  }

  const after = total + p.newCashUsd;
  const gap = new Map(drifts.map((d) => [d.key, (d.target_pct / 100) * after - d.value_usd]));
  const trades: Trade[] = [];

  // 1. New cash to the underweights, in proportion to how far below they are.
  let cash = p.newCashUsd;
  const under = drifts.filter((d) => (gap.get(d.key) ?? 0) > 0);
  const deficit = under.reduce((s, d) => s + gap.get(d.key)!, 0);
  for (const d of under) {
    if (cash <= 0 || deficit <= 0) break;
    const amount = Math.min(gap.get(d.key)!, (p.newCashUsd * gap.get(d.key)!) / deficit);
    if (amount >= t.min_trade_usd) {
      trades.push({ side: 'buy', key: d.key, usd: round2(amount), funded_by: 'new cash' });
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
    if (amount < t.min_trade_usd) continue;
    // Sell from the biggest holdings in the bucket first.
    let left = amount;
    for (const h of p.holdings.filter((x) => bucketOf(t, x.position) === d.key).sort((a, b) => b.value_usd - a.value_usd)) {
      if (left < t.min_trade_usd) break;
      const usd = Math.min(left, h.value_usd);
      const priceUsd = h.price_local * h.usd_per_local;
      const shares = Math.floor((usd / priceUsd) * 10_000) / 10_000;
      const gain = shares * (h.price_local - h.position.avg_cost) * h.usd_per_local;
      const account = h.position.account ?? 'default';
      const leftEur = p.allowanceLeftEur(account) - (allowanceUsed.get(account) ?? 0);
      const tax = capitalGainsTax({ gain_usd: gain, assetType: h.position.asset_type, partialExemptionPct: h.position.partial_exemption_pct,
        profile: p.profile, allowanceLeftEur: leftEur, usdPerEur: p.usdPerEur });
      allowanceUsed.set(account, (allowanceUsed.get(account) ?? 0) + tax.allowance_used_usd / p.usdPerEur);
      taxTotal += tax.tax_usd;
      trades.push({ side: 'sell', key: d.key, ticker: h.position.ticker, usd: round2(usd), shares, est_tax_usd: tax.tax_usd });
      left -= usd;
      raised += usd;
    }
  }

  // 3. Spend what the sales raised on what is still under.
  let proceeds = raised;
  for (const [key, g] of [...gap].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])) {
    if (proceeds < t.min_trade_usd) break;
    const amount = Math.min(g, proceeds);
    if (amount < t.min_trade_usd) continue;
    trades.push({ side: 'buy', key, usd: round2(amount), funded_by: 'sales' });
    proceeds -= amount;
  }

  if (trades.some((x) => x.side === 'sell')) notes.push('tax is estimated on average cost; your broker sells the oldest shares first (FIFO), which can differ');
  if (cash >= t.min_trade_usd) notes.push(`$${round2(cash)} of new cash is left over`);
  return { total_usd: round2(total), drifts, trades, est_tax_usd: round2(taxTotal), notes };
}
