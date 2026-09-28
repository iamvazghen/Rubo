/**
 * The owner's standing instruction for what to do with income as it arrives:
 * a split across four actions that must add up to 100 %, as a default plus
 * optional per-holding overrides.
 */

export type YieldAction = 'reinvest' | 'reserve' | 'withdraw' | 'repurpose';

export interface PlanPart {
  action: YieldAction;
  pct: number;
  /** repurpose: what to buy instead (ticker or a description). reinvest: another holding instead of the payer. */
  target?: string;
}

export interface YieldPlan {
  default: PlanPart[];
  overrides: Record<string, PlanPart[]>;
  updated_at: string | null;
}

export const DEFAULT_YIELD_PLAN: YieldPlan = {
  default: [
    { action: 'reinvest', pct: 40 },
    { action: 'reserve', pct: 30 },
    { action: 'withdraw', pct: 20 },
    { action: 'repurpose', pct: 10 },
  ],
  overrides: {},
  updated_at: null,
};

export const ACTION_LABEL: Record<YieldAction, string> = {
  reinvest: 'reinvest',
  reserve: 'cash reserve (for down markets)',
  withdraw: 'withdraw',
  repurpose: 'another asset',
};

export function validatePlan(parts: PlanPart[]): string | null {
  if (parts.length === 0) return 'the plan needs at least one part';
  const seen = new Set<string>();
  for (const p of parts) {
    if (!(p.action in ACTION_LABEL)) return `unknown action "${p.action}"`;
    if (!(p.pct > 0 && p.pct <= 100)) return `${p.action}: percentage must be between 0 and 100`;
    const key = `${p.action}:${p.target ?? ''}`;
    if (seen.has(key)) return `${p.action} appears twice`;
    seen.add(key);
  }
  const total = parts.reduce((s, p) => s + p.pct, 0);
  if (Math.abs(total - 100) > 0.001) return `parts add up to ${total} %, not 100 %`;
  return null;
}

export function planFor(plan: YieldPlan, ticker: string): { parts: PlanPart[]; override: boolean } {
  const own = plan.overrides[ticker.toUpperCase()];
  return own ? { parts: own, override: true } : { parts: plan.default, override: false };
}

/**
 * Parse "reinvest 40 reserve 30 withdraw 20 repurpose 10 VWCE" into parts.
 * A word after a percentage that is not an action is that part's target.
 */
export function parsePlanSpec(spec: string): PlanPart[] | string {
  const tokens = spec.trim().split(/[\s,]+/).filter(Boolean);
  const parts: PlanPart[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const action = tokens[i]!.toLowerCase() as YieldAction;
    if (!(action in ACTION_LABEL)) return `expected an action (reinvest, reserve, withdraw, repurpose), got "${tokens[i]}"`;
    const pct = Number((tokens[i + 1] ?? '').replace('%', ''));
    if (!Number.isFinite(pct)) return `${action} needs a percentage`;
    const part: PlanPart = { action, pct };
    const next = tokens[i + 2];
    if (next && !(next.toLowerCase() in ACTION_LABEL)) {
      part.target = next;
      i += 1;
    }
    parts.push(part);
    i += 1;
  }
  return validatePlan(parts) ?? parts;
}

export interface Allocation extends PlanPart {
  /** Base currency. */
  amount: number;
  /** reinvest/repurpose into a priced instrument: units to buy (fractional). */
  units?: number;
  unit_price?: number;
}

/**
 * Split an amount by the plan, in cents so nothing is lost to rounding: every
 * part is rounded down and the leftover cents go to the reserve (or the first
 * part if there is no reserve).
 */
export function allocate(total: number, parts: PlanPart[], priceOf?: (target: string | undefined, action: YieldAction) => number | undefined): Allocation[] {
  const cents = Math.round(total * 100);
  const out: Allocation[] = parts.map((p) => ({ ...p, amount: Math.floor((cents * p.pct) / 100) / 100 }));
  const assigned = out.reduce((s, a) => s + Math.round(a.amount * 100), 0);
  const leftover = cents - assigned;
  if (leftover > 0) {
    const sink = out.find((a) => a.action === 'reserve') ?? out[0]!;
    sink.amount = (Math.round(sink.amount * 100) + leftover) / 100;
  }
  for (const a of out) {
    if (a.action !== 'reinvest' && a.action !== 'repurpose') continue;
    const price = priceOf?.(a.target, a.action);
    if (price && price > 0) {
      a.unit_price = price;
      a.units = Math.floor((a.amount / price) * 10_000) / 10_000;
    }
  }
  return out;
}

export function describePlan(parts: PlanPart[]): string {
  return parts.map((p) => `${p.pct} % ${ACTION_LABEL[p.action]}${p.target ? ` → ${p.target}` : ''}`).join(', ');
}
