import type { MarketData } from '../market/yahoo.js';
import type { Position } from '../tools/portfolio/store.js';
import type { IncomeEvent, IncomeKind, Ledger } from './store.js';
import { baseCurrency } from '../utils/locale.js';
import { defaultAccountTax } from './brokers.js';
import { allowanceLeft, basePerAllowanceUnit } from './store.js';
import { taxOnPayment, type TaxProfile } from './tax.js';

const DAY = 86_400_000;
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ms = (day: string) => Date.parse(`${day}T00:00:00Z`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Payments per year from the gaps between past ex-dates, snapped to 1, 2, 4 or 12. */
export function paymentsPerYear(exDates: string[]): number {
  if (exDates.length < 2) return 1;
  const gaps = exDates.slice(1).map((d, i) => (ms(d) - ms(exDates[i]!)) / DAY);
  const perYear = 365 / median(gaps.slice(-8));
  return [1, 2, 4, 12].reduce((best, f) => (Math.abs(f - perYear) < Math.abs(best - perYear) ? f : best), 1);
}

function addMonths(day: string, months: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return toDay(d.getTime());
}

interface RawEvent {
  ticker: string;
  account?: string;
  kind: IncomeKind;
  exDate: string;
  payDate: string;
  payDateEstimated: boolean;
  perShare: number;
  currency: string;
  shares: number;
  status: 'estimated' | 'announced';
  source: string;
  previousPerShare?: number;
  isin?: string;
  assetType?: string;
  partialExemptionPct?: number;
}

/** Payments for one holding whose pay date falls in [today, today + horizon]. */
export async function eventsForPosition(p: Position, market: MarketData, today: string, horizonDays = 365): Promise<RawEvent[]> {
  const end = ms(today) + horizonDays * DAY;
  const base = {
    ticker: p.ticker, account: p.account, isin: p.isin, assetType: p.asset_type,
    partialExemptionPct: p.partial_exemption_pct,
  };

  if (p.asset_type === 'cash') return [];

  if (p.asset_type === 'bond') {
    if (!p.coupon_rate_pct || !p.coupon_frequency || !p.next_coupon_date || !p.face_value) return [];
    const perPayment = (p.face_value * p.coupon_rate_pct) / 100 / p.coupon_frequency;
    const out: RawEvent[] = [];
    for (let d = p.next_coupon_date; ms(d) <= end; d = addMonths(d, 12 / p.coupon_frequency)) {
      if (ms(d) < ms(today)) continue;
      out.push({ ...base, kind: 'coupon', exDate: d, payDate: d, payDateEstimated: false, perShare: perPayment,
        currency: p.currency, shares: 1, status: 'announced', source: 'coupon terms you entered' });
    }
    return out;
  }

  const symbol = p.data_symbol ?? p.ticker;
  const history = await market.dividendHistory(symbol);
  if (!history || history.dividends.length === 0) return []; // accumulating fund or no payer
  const kind: IncomeKind = p.asset_type === 'etf' || history.instrumentType === 'ETF' ? 'distribution' : 'dividend';
  const past = history.dividends;
  const perYear = paymentsPerYear(past.map((d) => d.exDate));
  const last = past[past.length - 1]!;
  const cal = await market.dividendCalendar(symbol);
  const lagDays = cal?.exDate && cal.payDate ? (ms(cal.payDate) - ms(cal.exDate)) / DAY : symbol.includes('.') ? 7 : 14;

  const out: RawEvent[] = [];
  let previous = past.length > 1 ? past[past.length - 2]!.amount : undefined;
  let exDate = last.exDate;
  let perShare = last.amount;
  let status: RawEvent['status'] = 'estimated';
  let payDate = toDay(ms(exDate) + lagDays * DAY);
  let payEstimated = true;

  // The announced one: either the latest ex-date already in the history (paid
  // later), or a future ex-date whose amount follows the forward rate.
  if (cal?.exDate && cal.payDate) {
    const inHistory = past.find((d) => d.exDate === cal.exDate);
    exDate = cal.exDate;
    payDate = cal.payDate;
    payEstimated = false;
    status = 'announced';
    if (inHistory) {
      perShare = inHistory.amount;
      const i = past.indexOf(inHistory);
      previous = i > 0 ? past[i - 1]!.amount : undefined;
    } else {
      previous = last.amount;
      perShare = cal.annualRate ? cal.annualRate / perYear : last.amount;
    }
  }

  const step = 12 / perYear;
  for (let i = 0; i < 24; i++) {
    if (ms(payDate) > end) break;
    if (ms(payDate) >= ms(today)) {
      out.push({ ...base, kind, exDate, payDate, payDateEstimated: payEstimated, perShare, currency: history.currency,
        shares: p.shares, status, source: status === 'announced' ? 'Yahoo calendar' : 'projected from payment history',
        previousPerShare: previous });
    }
    // Everything after the first is a projection at the same amount.
    previous = perShare;
    exDate = addMonths(exDate, step);
    payDate = toDay(ms(exDate) + lagDays * DAY);
    payEstimated = true;
    status = 'estimated';
  }
  return out;
}

/**
 * The income calendar for the whole portfolio. The allowance is consumed in pay
 * date order, so later payments in the year correctly show more tax.
 */
export async function buildIncomeCalendar(p: {
  positions: Position[];
  market: MarketData;
  profile: TaxProfile;
  ledger: Ledger;
  today: string;
  horizonDays?: number;
}): Promise<IncomeEvent[]> {
  const raw = (await Promise.all(p.positions.map((pos) => eventsForPosition(pos, p.market, p.today, p.horizonDays))))
    .flat()
    .sort((a, b) => a.payDate.localeCompare(b.payDate));

  const base = baseCurrency();
  const perUnit = await basePerAllowanceUnit(p.profile, p.market);
  const fx = new Map<string, number>();
  const used: Ledger['allowance_used'] = structuredClone(p.ledger.allowance_used);
  const events: IncomeEvent[] = [];

  for (const r of raw) {
    if (!fx.has(r.currency)) fx.set(r.currency, (await p.market.rate(r.currency, base)) ?? NaN);
    const rate = fx.get(r.currency)!;
    const account = r.account ?? Object.keys(p.profile.accounts)[0] ?? 'default';
    const acct = p.profile.accounts[account] ?? defaultAccountTax(account, p.profile.residence);
    const year = Number(r.payDate.slice(0, 4));
    const gross = r.shares * r.perShare * rate;
    const tax = taxOnPayment({
      gross: Number.isFinite(gross) ? gross : 0,
      isin: r.isin, assetType: r.assetType, partialExemptionPct: r.partialExemptionPct,
      account: acct, profile: p.profile,
      allowanceLeft: allowanceLeft(p.profile, { ...p.ledger, allowance_used: used }, account, year),
      basePerAllowanceUnit: perUnit,
    });
    if (!Number.isFinite(gross)) tax.notes.push(`no ${r.currency}→${base} rate, amount unknown`);
    const prior = used[account]?.year === year ? used[account]!.amount : 0;
    used[account] = { year, amount: prior + tax.allowance_used / perUnit };

    events.push({
      id: `${r.ticker}:${r.exDate}`, ticker: r.ticker, account: r.account, kind: r.kind,
      exDate: r.exDate, payDate: r.payDate, payDateEstimated: r.payDateEstimated,
      perShare: r.perShare, currency: r.currency, shares: r.shares,
      gross: Math.round((Number.isFinite(gross) ? gross : 0) * 100) / 100, tax,
      status: r.status, source: r.source, previousPerShare: r.previousPerShare,
    });
  }
  return events;
}
