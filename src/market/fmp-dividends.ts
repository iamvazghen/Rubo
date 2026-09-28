import type { DividendCalendar } from './yahoo.js';

/**
 * Announced dividend (ex-date, pay date, amount) from Financial Modeling Prep,
 * the roadmap's second source after Yahoo. Only with FMP_API_KEY; the free plan
 * covers US listings, so a non-US symbol simply returns null.
 */
const PER_YEAR: Record<string, number> = { Monthly: 12, Quarterly: 4, 'Semi-Annual': 2, Annual: 1 };

export function fmpToCalendar(rows: { date?: string; paymentDate?: string; dividend?: number; frequency?: string }[]): DividendCalendar | null {
  const latest = rows.filter((r) => r.date).sort((a, b) => b.date!.localeCompare(a.date!))[0];
  if (!latest) return null;
  const perYear = latest.frequency ? PER_YEAR[latest.frequency] : undefined;
  return {
    exDate: latest.date,
    payDate: latest.paymentDate || undefined,
    annualRate: perYear && latest.dividend ? latest.dividend * perYear : undefined,
  };
}

export async function fmpDividendCalendar(symbol: string): Promise<DividendCalendar | null> {
  const key = process.env.FMP_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(`https://financialmodelingprep.com/stable/dividends?symbol=${encodeURIComponent(symbol)}&apikey=${key}`,
      { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const rows = await res.json().catch(() => null);
    return Array.isArray(rows) ? fmpToCalendar(rows) : null;
  } catch {
    return null;
  }
}

/** The fresher of two calendars: a later ex-date wins; one with a pay date beats one without. */
export function fresher(a: DividendCalendar | null, b: DividendCalendar | null): DividendCalendar | null {
  if (!a?.exDate) return b?.exDate ? b : a;
  if (!b?.exDate) return a;
  if (a.exDate !== b.exDate) return a.exDate > b.exDate ? a : b;
  return a.payDate ? { ...a, annualRate: a.annualRate ?? b.annualRate } : { ...b, annualRate: b.annualRate ?? a.annualRate };
}
