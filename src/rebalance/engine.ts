import type { AssetType, Position } from '../tools/portfolio/store.js';
import { capitalGainsTax, type TaxProfile } from '../income/tax.js';

/**
 * Rebalancing maths. Pure: valued holdings and targets in, a trade list out.
 * The model explains the result; it never decides the numbers. Nothing here
 * places an order.
 */

export type TargetMode = 'holding' | 'asset_type' | 'region' | 'sector';

export interface Targets {
  /** What the weights are for: each holding (ticker), asset type (stock, etf, bond, cash), region or sector. */
  mode: TargetMode;
  targets: Record<string, number>;
  /** Tolerance in percentage points before anything is proposed. */
  band_pct: number;
  /** Smallest trade worth making, base currency. */
  min_trade: number;
  /** Broker fees per trade: a fixed amount (base currency) plus a percentage of the trade. */
  fee_fixed?: number;
  fee_pct?: number;
  updated_at: string | null;
}

export const DEFAULT_TARGETS: Targets = { mode: 'asset_type', targets: {}, band_pct: 5, min_trade: 50, fee_fixed: 0, fee_pct: 0, updated_at: null };

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
  /** Weight once the proposed trades are done. */
  after_pct?: number;
}

export interface Trade {
  side: 'buy' | 'sell';
  key: string;
  ticker?: string;
  /** Base currency, before fees. */
  amount: number;
  shares?: number;
  est_tax?: number;
  est_fee?: number;
  /** How the sold shares' cost was taken: the oldest purchases first, or the average. */
  cost_basis?: 'fifo' | 'average';
  funded_by?: 'new cash' | 'sales';
}

export interface Proposal {
  total: number;
  drifts: Drift[];
  trades: Trade[];
  est_tax: number;
  est_fees: number;
  notes: string[];
}

export function bucketOf(t: Pick<Targets, 'mode'>, p: Position): string {
  switch (t.mode) {
    case 'holding': return p.ticker;
    case 'region': return p.region ?? 'unassigned';
    case 'sector': return p.sector ?? 'unassigned';
    default: return (p.asset_type ?? 'stock') as AssetType;
  }
}
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
 * Cost of selling `shares`, in the position's cost currency: the oldest
 * purchases first (FIFO) when the lots are known and cover the sale, which is
 * how a German broker taxes it; otherwise the average cost.
 */
export function saleCost(p: Position, shares: number): { cost: number; basis: 'fifo' | 'average' } {
  const lots = p.lots ?? [];
  if (lots.reduce((s, l) => s + l.shares, 0) + 1e-6 < shares) return { cost: shares * p.avg_cost, basis: 'average' };
  let left = shares;
  let cost = 0;
  for (const lot of lots) {
    if (left <= 1e-9) break;
    const used = Math.min(lot.shares, left);
    cost += used * lot.price;
    left -= used;
  }
  return { cost, basis: 'fifo' };
}

/**
 * Cheapest path back to target: new cash goes to underweights first; only then
 * are overweights sold, largest overweight first, with the owner's tax on the
 * realised gain and the broker's fees estimated.
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
  const fee = (amount: number) => round2((t.fee_fixed ?? 0) + (amount * (t.fee_pct ?? 0)) / 100);
  // Largest purchase `available` pays for once its own fee is taken out.
  const affordable = (available: number) => Math.max(0, (available - (t.fee_fixed ?? 0)) / (1 + (t.fee_pct ?? 0) / 100));
  const notes: string[] = [];
  const targetSum = Object.values(t.targets).reduce((s, v) => s + v, 0);
  if (Math.abs(targetSum - 100) > 0.01) notes.push(`targets add up to ${targetSum} %, not 100 % - weights are compared as given`);
  if ((t.mode === 'region' || t.mode === 'sector') && p.holdings.some((h) => bucketOf(t, h.position) === 'unassigned')) {
    const which = p.holdings.filter((h) => bucketOf(t, h.position) === 'unassigned').map((h) => h.position.ticker);
    notes.push(`no ${t.mode} known for ${which.join(', ')}: set it with /targets tag <ticker> ${t.mode} <name>`);
  }

  const { total, drifts } = computeDrift(p.holdings, p.reserve, t);
  if (!drifts.some((d) => d.outside_band)) {
    return { total: round2(total), drifts, trades: [], est_tax: 0, est_fees: 0, notes: [...notes, `everything is within ±${t.band_pct} points of target`] };
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
    const amount = Math.min(gap.get(d.key)!, affordable((p.newCash * gap.get(d.key)!) / deficit));
    if (amount >= t.min_trade) {
      const f = fee(amount);
      trades.push({ side: 'buy', key: d.key, amount: round2(amount), est_fee: f, funded_by: 'new cash' });
      gap.set(d.key, gap.get(d.key)! - amount);
      cash -= amount + f;
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
      const { cost, basis } = saleCost(h.position, shares);
      const f = fee(amount);
      // Fees on the sale reduce the gain, as they do on a tax return.
      const gain = shares * priceBase - cost * h.base_per_cost - f;
      const account = h.position.account ?? 'default';
      const leftAllowance = p.allowanceLeft(account) - (allowanceUsed.get(account) ?? 0);
      const tax = capitalGainsTax({ gain, assetType: h.position.asset_type, partialExemptionPct: h.position.partial_exemption_pct,
        profile: p.profile, allowanceLeft: leftAllowance, basePerAllowanceUnit: p.basePerAllowanceUnit });
      allowanceUsed.set(account, (allowanceUsed.get(account) ?? 0) + tax.allowance_used / p.basePerAllowanceUnit);
      taxTotal += tax.tax;
      trades.push({ side: 'sell', key: d.key, ticker: h.position.ticker, amount: round2(amount), shares, est_tax: tax.tax, est_fee: f, cost_basis: basis });
      left -= amount;
      raised += amount - f;
    }
  }

  // 3. Spend what the sales raised on what is still under.
  let proceeds = raised;
  for (const [key, g] of [...gap].filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1])) {
    if (proceeds < t.min_trade) break;
    const amount = Math.min(g, affordable(proceeds));
    if (amount < t.min_trade) continue;
    const f = fee(amount);
    trades.push({ side: 'buy', key, amount: round2(amount), est_fee: f, funded_by: 'sales' });
    proceeds -= amount + f;
  }

  // Weights once everything is done (fees paid, cash not placed left as cash).
  const values = new Map(drifts.map((d) => [d.key, d.value]));
  for (const x of trades) values.set(x.key, (values.get(x.key) ?? 0) + (x.side === 'buy' ? x.amount : -x.amount));
  const unplaced = Math.max(0, cash) + Math.max(0, proceeds);
  if (t.mode === 'asset_type' && t.targets.cash != null) values.set('cash', (values.get('cash') ?? 0) + unplaced);
  const totalAfter = [...values.values()].reduce((s, v) => s + v, 0);
  for (const d of drifts) d.after_pct = totalAfter ? round2(((values.get(d.key) ?? 0) / totalAfter) * 100) : 0;

  const sells = trades.filter((x) => x.side === 'sell');
  if (sells.some((x) => x.cost_basis === 'average')) {
    notes.push(`tax on ${sells.filter((x) => x.cost_basis === 'average').map((x) => x.ticker).join(', ')} is estimated on average cost; import a transaction export to use your oldest purchases first (FIFO), as your broker will`);
  }
  if (cash >= t.min_trade) notes.push(`${round2(cash)} of new cash is left over`);
  const fees = round2(trades.reduce((s, x) => s + (x.est_fee ?? 0), 0));
  return { total: round2(total), drifts, trades, est_tax: round2(taxTotal), est_fees: fees, notes };
}
