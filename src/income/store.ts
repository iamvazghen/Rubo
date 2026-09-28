import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MarketData } from '../market/yahoo.js';
import { baseCurrency } from '../utils/locale.js';
import { ruboPath } from '../utils/paths.js';
import { defaultAccountTax } from './brokers.js';
import { jurisdictionFor } from './jurisdictions.js';
import { DEFAULT_YIELD_PLAN, type Allocation, type YieldPlan } from './plan.js';
import { EMPTY_TAX_PROFILE, type TaxBreakdown, type TaxProfile } from './tax.js';

/**
 * Income state under `.rubo/income/`: the owner's plan and tax profile, the
 * calendar of expected payments, and a ledger of confirmed ones. Amounts are in
 * the base currency. Paths are resolved per call so a RUBO_HOME set after
 * import is honoured.
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
  /** Per share, in the paying currency. */
  perShare: number;
  currency: string;
  /** Shares expected to be held on the ex-date (today's holding). */
  shares: number;
  /** Gross, in the base currency. */
  gross: number;
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
  net: number;
  allocations: Allocation[];
  tax: TaxBreakdown;
}

export interface Ledger {
  /** Running balance of the down-market cash reserve, base currency. */
  reserve: number;
  /** Allowance consumed per account and calendar year, in the jurisdiction's currency. */
  allowance_used: Record<string, { year: number; amount: number }>;
  entries: LedgerEntry[];
  /** The owner's own additions (+) and uses (−) of the reserve, dated. */
  reserve_moves?: { at: string; amount: number; note: string }[];
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
  tax: () => readJson<TaxProfile>('tax.json', EMPTY_TAX_PROFILE),
  saveTax: (t: TaxProfile) => writeJson('tax.json', t),
  calendar: () => readJson<{ events: IncomeEvent[]; refreshed_at: string | null }>('calendar.json', { events: [], refreshed_at: null }),
  saveCalendar: (events: IncomeEvent[]) => writeJson('calendar.json', { events, refreshed_at: new Date().toISOString() }),
  ledger: () => readJson<Ledger>('ledger.json', { reserve: 0, allowance_used: {}, entries: [] }),
  saveLedger: (l: Ledger) => writeJson('ledger.json', l),
};

const MONEY_FIELDS = ['gross', 'withholding', 'received', 'residence_tax', 'allowance_used', 'net'] as const;

/**
 * Re-express everything recorded in the base currency after it changes: the
 * reserve, confirmed payments and the calendar. The allowance used stays in the
 * jurisdiction's own currency. Returns how many confirmed payments were converted.
 */
export function convertRecorded(rate: number): number {
  const r2 = (n: number) => Math.round(n * rate * 100) / 100;
  const tax = (t: TaxBreakdown) => { for (const f of MONEY_FIELDS) t[f] = r2(t[f]); };
  const ledger = incomeStore.ledger();
  ledger.reserve = r2(ledger.reserve);
  for (const m of ledger.reserve_moves ?? []) m.amount = r2(m.amount);
  for (const e of ledger.entries) {
    e.net = r2(e.net);
    tax(e.tax);
    for (const a of e.allocations) {
      a.amount = r2(a.amount);
      if (a.unit_price != null) a.unit_price = r2(a.unit_price);
    }
  }
  incomeStore.saveLedger(ledger);
  const cal = incomeStore.calendar();
  for (const e of cal.events) {
    e.gross = r2(e.gross);
    tax(e.tax);
  }
  incomeStore.saveCalendar(cal.events);
  return ledger.entries.length;
}

/** Make sure every account that holds something has tax settings (defaults from the broker registry). */
export function ensureAccounts(accounts: string[]): string[] {
  const profile = incomeStore.tax();
  const added = accounts.filter((a) => !profile.accounts[a]);
  if (added.length === 0) return [];
  for (const a of added) profile.accounts[a] = defaultAccountTax(a, profile.residence);
  incomeStore.saveTax(profile);
  return added;
}

/** Base currency per unit of the jurisdiction's allowance currency (1 when there are no rules or they are in the base currency). */
export async function basePerAllowanceUnit(profile: TaxProfile, market: MarketData): Promise<number> {
  const j = jurisdictionFor(profile.residence, profile.options);
  if (!j || j.currency === 'BASE' || j.currency === baseCurrency()) return 1;
  return (await market.rate(j.currency, baseCurrency())) ?? 1;
}

/** Allowance still usable for an account this year, in the jurisdiction's currency. */
export function allowanceLeft(profile: TaxProfile, ledger: Ledger, account: string, year = new Date().getFullYear()): number {
  const j = jurisdictionFor(profile.residence, profile.options);
  if (!j) return 0;
  const used = (a: string) => {
    const u = ledger.allowance_used[a];
    return u && u.year === year ? u.amount : 0;
  };
  const total = j.allowance(profile.filing, profile.options);
  const atBroker = (name: string) => Boolean(profile.accounts[name]?.domestic && j.brokerAppliesAllowance);
  if (atBroker(account)) return Math.max(0, profile.accounts[account]!.allowance_assigned - used(account));
  // Everything not applied by a broker is claimed with the return, shared by the other accounts.
  const assigned = Object.keys(profile.accounts).filter(atBroker).reduce((s, a) => s + profile.accounts[a]!.allowance_assigned, 0);
  const usedElsewhere = Object.keys({ ...profile.accounts, ...ledger.allowance_used }).filter((a) => !atBroker(a)).reduce((s, a) => s + used(a), 0);
  return Math.max(0, total - assigned - usedElsewhere);
}
