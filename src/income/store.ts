import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ruboPath } from '../utils/paths.js';
import { DEFAULT_YIELD_PLAN, type Allocation, type YieldPlan } from './plan.js';
import { DEFAULT_TAX_PROFILE, type TaxBreakdown, type TaxProfile } from './tax.js';

/**
 * Income state under `.rubo/income/`: the owner's plan and tax profile, the
 * calendar of expected payments, and a ledger of confirmed ones. Paths are
 * resolved per call so a RUBO_HOME set after import is honoured.
 */

export type IncomeKind = 'dividend' | 'distribution' | 'coupon';
export type IncomeStatus = 'estimated' | 'announced' | 'paid' | 'skipped';

export interface IncomeEvent {
  /** `${ticker}:${exDate}` - stable across refreshes, so reminders are not duplicated. */
  id: string;
  ticker: string;
  account?: string;
  kind: IncomeKind;
  exDate: string;
  /** Pay date; estimated from past lags when not announced. */
  payDate: string;
  payDateEstimated: boolean;
  perShare: number;
  currency: string;
  /** Shares expected to be held on the ex-date (today's holding). */
  shares: number;
  gross_usd: number;
  tax: TaxBreakdown;
  status: IncomeStatus;
  source: string;
  /** Previous payment per share, to flag a cut. */
  previousPerShare?: number;
  reminderJobs?: { beforeEx?: string; onPay?: string };
  /** Jev's probability of a dividend cut within 12 months, when available. */
  cutRisk?: number;
}

export interface LedgerEntry {
  eventId: string;
  ticker: string;
  confirmedAt: string;
  net_usd: number;
  allocations: Allocation[];
  tax: TaxBreakdown;
}

export interface Ledger {
  /** Running balance of the down-market cash reserve, USD. */
  reserve_usd: number;
  /** Allowance consumed this calendar year, EUR, per account. */
  allowance_used_eur: Record<string, { year: number; eur: number }>;
  entries: LedgerEntry[];
}

const file = (name: string) => ruboPath('income', name);

function readJson<T>(name: string, fallback: T): T {
  const path = file(name);
  if (!existsSync(path)) return structuredClone(fallback);
  try {
    return { ...structuredClone(fallback), ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(name: string, value: unknown): void {
  const path = file(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

export const incomeStore = {
  plan: () => readJson<YieldPlan>('plan.json', DEFAULT_YIELD_PLAN),
  savePlan: (p: YieldPlan) => writeJson('plan.json', { ...p, updated_at: new Date().toISOString() }),
  tax: () => readJson<TaxProfile>('tax.json', DEFAULT_TAX_PROFILE),
  saveTax: (t: TaxProfile) => writeJson('tax.json', t),
  calendar: () => readJson<{ events: IncomeEvent[]; refreshed_at: string | null }>('calendar.json', { events: [], refreshed_at: null }),
  saveCalendar: (events: IncomeEvent[]) => writeJson('calendar.json', { events, refreshed_at: new Date().toISOString() }),
  ledger: () => readJson<Ledger>('ledger.json', { reserve_usd: 0, allowance_used_eur: {}, entries: [] }),
  saveLedger: (l: Ledger) => writeJson('ledger.json', l),
};

/** Allowance still usable for an account this year, EUR. */
export function allowanceLeftEur(profile: TaxProfile, ledger: Ledger, account: string, year = new Date().getFullYear()): number {
  const acct = profile.accounts[account];
  const usedFor = (a: string) => {
    const u = ledger.allowance_used_eur[a];
    return u && u.year === year ? u.eur : 0;
  };
  const total = profile.filing === 'joint' ? 2000 : 1000;
  if (acct?.domestic) return Math.max(0, acct.exemption_order_eur - usedFor(account));
  // Foreign broker: whatever is not assigned to a domestic broker, claimed in the return.
  const assigned = Object.values(profile.accounts).filter((a) => a.domestic).reduce((s, a) => s + a.exemption_order_eur, 0);
  const foreignUsed = Object.entries(profile.accounts).filter(([, a]) => !a.domestic).reduce((s, [name]) => s + usedFor(name), 0);
  return Math.max(0, total - assigned - foreignUsed);
}
