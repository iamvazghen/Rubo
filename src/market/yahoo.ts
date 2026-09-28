/**
 * Yahoo market data for the income, import and rebalancing features: prices,
 * dividend history, the next announced dividend, FX to USD and ISIN lookup.
 *
 * Everything returns plain data and nothing here decides anything, so the
 * modules that do decide can be tested against fixtures through the
 * `MarketData` interface instead of the network.
 */

export interface DividendHistory {
  currency: string;
  /** Yahoo instrument type, e.g. EQUITY or ETF. */
  instrumentType: string;
  /** Past payments, oldest first; `exDate` is YYYY-MM-DD. */
  dividends: Array<{ exDate: string; amount: number }>;
}

export interface DividendCalendar {
  /** Next (or most recent) ex-dividend date, YYYY-MM-DD. */
  exDate?: string;
  /** Payment date belonging to it, YYYY-MM-DD. */
  payDate?: string;
  /** Forward annual dividend per share. */
  annualRate?: number;
}

export interface Quote {
  price: number;
  currency: string;
}

export interface IsinMatch {
  symbol: string;
  exchange: string;
  quoteType: string;
}

export interface MarketData {
  quote(symbol: string): Promise<Quote | null>;
  dividendHistory(symbol: string): Promise<DividendHistory | null>;
  dividendCalendar(symbol: string): Promise<DividendCalendar | null>;
  /** USD per one unit of `currency`. */
  usdPerUnit(currency: string): Promise<number | null>;
  searchIsin(isin: string): Promise<IsinMatch[]>;
  /** Dividend-relevant fundamentals (numbers only; missing ones omitted). */
  fundamentals(symbol: string): Promise<Record<string, number> | null>;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const day = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, ...headers }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// quoteSummary (the only endpoint with upcoming dividend dates) needs a cookie
// plus a "crumb" token; the chart and search endpoints do not.
let session: { cookie: string; crumb: string; at: number } | null = null;

async function yahooSession(force = false): Promise<typeof session> {
  if (session && !force && Date.now() - session.at < 3_600_000) return session;
  try {
    const first = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { 'User-Agent': UA, Cookie: cookie },
    });
    const crumb = (await crumbRes.text()).trim();
    if (!cookie || !crumb || crumb.includes('<')) return null;
    session = { cookie, crumb, at: Date.now() };
    return session;
  } catch {
    return null;
  }
}

async function quoteSummary(symbol: string, modules: string): Promise<any | null> {
  for (const force of [false, true]) {
    const s = await yahooSession(force);
    if (!s) return null;
    const json = await getJson(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&crumb=${encodeURIComponent(s.crumb)}`,
      { Cookie: s.cookie },
    );
    const r = json?.quoteSummary?.result?.[0];
    if (r) return r; // otherwise a stale crumb: retry once with a fresh session
  }
  return null;
}

const quoteCache = new Map<string, { at: number; quote: Quote }>();

export const yahoo: MarketData = {
  async quote(symbol) {
    const hit = quoteCache.get(symbol);
    if (hit && Date.now() - hit.at < 300_000) return hit.quote;
    const json = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`);
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) return null;
    const quote = { price: meta.regularMarketPrice as number, currency: String(meta.currency ?? 'USD') };
    quoteCache.set(symbol, { at: Date.now(), quote });
    return quote;
  },

  async dividendHistory(symbol) {
    const json = await getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3y&interval=1mo&events=div`,
    );
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const events = Object.values(result.events?.dividends ?? {}) as Array<{ amount: number; date: number }>;
    return {
      currency: String(result.meta?.currency ?? 'USD'),
      instrumentType: String(result.meta?.instrumentType ?? ''),
      dividends: events
        .map((e) => ({ exDate: day(e.date), amount: e.amount }))
        .sort((a, b) => a.exDate.localeCompare(b.exDate)),
    };
  },

  async dividendCalendar(symbol) {
    {
      const r = await quoteSummary(symbol, 'calendarEvents,summaryDetail');
      if (!r) return null;
      const cal = r.calendarEvents ?? {};
      return {
        exDate: cal.exDividendDate?.raw ? day(cal.exDividendDate.raw) : undefined,
        payDate: cal.dividendDate?.raw ? day(cal.dividendDate.raw) : undefined,
        annualRate: r.summaryDetail?.dividendRate?.raw,
      };
    }
  },

  async fundamentals(symbol) {
    const r = await quoteSummary(symbol, 'summaryDetail,financialData,defaultKeyStatistics');
    if (!r) return null;
    const pick = (mod: any, keys: string[]) => Object.fromEntries(keys.map((k) => [k, mod?.[k]?.raw]).filter(([, v]) => typeof v === 'number'));
    const out: Record<string, number> = {
      ...pick(r.summaryDetail, ['payoutRatio', 'dividendYield', 'fiveYearAvgDividendYield', 'dividendRate', 'trailingAnnualDividendRate']),
      ...pick(r.financialData, ['freeCashflow', 'operatingCashflow', 'debtToEquity', 'earningsGrowth', 'revenueGrowth', 'totalCash', 'totalDebt']),
      ...pick(r.defaultKeyStatistics, ['sharesOutstanding', 'trailingEps', 'forwardEps']),
    };
    const rate = out.dividendRate ?? out.trailingAnnualDividendRate;
    if (rate && out.sharesOutstanding && out.freeCashflow) out.fcfDividendCover = out.freeCashflow / (rate * out.sharesOutstanding);
    return out;
  },

  async usdPerUnit(currency) {
    if (currency === 'USD') return 1;
    // London prices come in pence.
    if (currency === 'GBp' || currency === 'GBX') {
      const gbp = await this.usdPerUnit('GBP');
      return gbp == null ? null : gbp / 100;
    }
    const q = await this.quote(`${currency.toUpperCase()}USD=X`);
    return q?.price ?? null;
  },

  async searchIsin(isin) {
    const json = await getJson(
      `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(isin)}&quotesCount=8&newsCount=0`,
    );
    return ((json?.quotes ?? []) as any[])
      .filter((q) => q.symbol)
      .map((q) => ({ symbol: String(q.symbol), exchange: String(q.exchange ?? ''), quoteType: String(q.quoteType ?? '') }));
  },
};
