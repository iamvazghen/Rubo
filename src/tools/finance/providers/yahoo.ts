/**
 * Yahoo Finance — free global quotes and price history, no API key.
 *
 * This exists because the paid path does not work. EODHD's plan here allows
 * roughly 20 calls a day and does not carry Japan, India, Singapore, Israel or
 * Saudi Arabia at all. Yahoo carries all of them, returns the currency and
 * exchange with every quote, and costs nothing.
 *
 * Every suffix in the table below was verified live against the API rather than
 * copied from documentation — the hand-written exchange table this replaces had
 * four codes that simply did not exist.
 *
 * The trade-off, stated plainly: this is an undocumented endpoint. It can change
 * without notice. So it is registered as one provider among several rather than
 * as the only path, and the meta-tools fall back around it.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_INTRADAY_QUOTE, TTL_EOD_PRICES } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

const LABEL = 'Yahoo Finance';
const BASE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';

/** Yahoo rejects requests without a browser-ish agent. */
const HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; Rubo/1.0)' };

/**
 * Our canonical exchange code -> Yahoo suffix. All verified live 2026-09-07.
 * Codes match src/tools/finance/region-helpers.ts, with extra entries for the
 * markets only Yahoo can reach.
 */
const EXCHANGE_TO_YAHOO: Record<string, string> = {
  // North America
  US: '', TO: '.TO', V: '.V', NEO: '.NE', MX: '.MX',
  // Europe
  LSE: '.L', XETRA: '.DE', F: '.F', DU: '.DU', MU: '.MU', STU: '.SG', HA: '.HM', HM: '.HM',
  PA: '.PA', AS: '.AS', BR: '.BR', MC: '.MC', MI: '.MI', LS: '.LS', IR: '.IR', VI: '.VI',
  SW: '.SW', ST: '.ST', CO: '.CO', OL: '.OL', HE: '.HE', LU: '.LU',
  WAR: '.WA', PR: '.PR', BUD: '.BD', AT: '.AT', RO: '.RO',
  // Asia-Pacific
  HK: '.HK', SHG: '.SS', SHE: '.SZ', KO: '.KS', KQ: '.KQ', TW: '.TW', TWO: '.TWO',
  AU: '.AX', NZ: '.NZ', BK: '.BK', JK: '.JK', KLSE: '.KL', VN: '.VN', KAR: '.KA',
  // South America
  SA: '.SA', BA: '.BA', SN: '.SN',
  // Africa / Middle East
  JSE: '.JO', EGX: '.CA',

  // Markets no configured paid provider reaches. These have no EODHD code, so
  // the canonical name is the country's common one.
  JP: '.T', TSE: '.T',
  NSE: '.NS', BSE: '.BO',
  SI: '.SI',
  TA: '.TA',
  SR: '.SR',
};

/** Exchanges reachable only through Yahoo, for honest capability reporting. */
export const YAHOO_ONLY_EXCHANGES = ['JP', 'TSE', 'NSE', 'BSE', 'SI', 'TA', 'SR'] as const;

/**
 * Translate a `TICKER.EXCHANGE` symbol into Yahoo's notation. A bare symbol is
 * assumed to be US and passed through. An unknown suffix is passed through
 * untouched rather than guessed at — Yahoo will simply report no data, which is
 * a better failure than silently querying the wrong company.
 */
export function toYahooSymbol(ticker: string): string {
  const raw = ticker.trim().toUpperCase();
  const dot = raw.lastIndexOf('.');
  if (dot === -1) return raw;

  const symbol = raw.slice(0, dot);
  const exchange = raw.slice(dot + 1);
  const suffix = EXCHANGE_TO_YAHOO[exchange];
  return suffix === undefined ? raw : `${symbol}${suffix}`;
}

export function isYahooSupported(exchange: string): boolean {
  return exchange.toUpperCase() in EXCHANGE_TO_YAHOO;
}

interface ChartMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  currency?: string;
  exchangeName?: string;
  fullExchangeName?: string;
  longName?: string;
  shortName?: string;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketVolume?: number;
  regularMarketTime?: number;
}

async function fetchChart(
  symbol: string,
  params: Record<string, string>,
  ttlMs: number,
): Promise<{ meta: ChartMeta; timestamps: number[]; quote: Record<string, number[]>; url: string }> {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(symbol)}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await callProvider({
    provider: 'yahoo',
    endpoint: 'chart',
    params: { symbol, ...params },
    url: url.toString(),
    ttlMs,
    headers: HEADERS,
  });

  const chart = (res.data as { chart?: { result?: unknown[]; error?: { description?: string } } }).chart;
  if (chart?.error) {
    throw new Error(`[${LABEL}] ${chart.error.description ?? 'request rejected'}`);
  }
  const result = chart?.result?.[0] as
    | { meta?: ChartMeta; timestamp?: number[]; indicators?: { quote?: Array<Record<string, number[]>> } }
    | undefined;
  if (!result?.meta) {
    throw new Error(`[${LABEL}] no data for ${symbol}`);
  }

  return {
    meta: result.meta,
    timestamps: result.timestamp ?? [],
    quote: result.indicators?.quote?.[0] ?? {},
    url: url.toString(),
  };
}

function sourceRefs(url: string, title: string): SourceRef[] {
  return [{ id: 1, url, provider: LABEL, title }];
}

const quote = new DynamicStructuredTool({
  name: 'yahoo_quote',
  description:
    'Live quote for any listed security worldwide from Yahoo Finance — price, currency, exchange, day range and 52-week range. Free, no key, and the only configured source for Japan, India, Singapore, Israel and Saudi Arabia. Accepts TICKER.EXCHANGE notation (VOD.LSE, 7203.TSE, PETR4.SA, NPN.JSE) or a bare US symbol.',
  schema: z.object({
    ticker: z.string().describe('TICKER.EXCHANGE (e.g. "VOD.LSE", "7203.TSE") or a bare US symbol.'),
  }),
  func: async ({ ticker }) => {
    const symbol = toYahooSymbol(ticker);
    const { meta, url } = await fetchChart(symbol, { interval: '1d', range: '5d' }, TTL_INTRADAY_QUOTE);

    const price = meta.regularMarketPrice ?? null;
    const previous = meta.previousClose ?? meta.chartPreviousClose ?? null;
    const changePct =
      price != null && previous != null && previous !== 0
        ? ((price - previous) / previous) * 100
        : null;

    return formatToolResult(
      {
        ticker: ticker.toUpperCase(),
        yahoo_symbol: symbol,
        name: meta.longName ?? meta.shortName ?? null,
        price,
        // Some venues quote in a sub-unit: GBp (pence), ZAc (cents), ILA
        // (agorot). Yahoo reports that here, so it is passed through verbatim
        // rather than assumed to be the major unit.
        currency: meta.currency ?? null,
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
        previous_close: previous,
        change_pct: changePct,
        day_high: meta.regularMarketDayHigh ?? null,
        day_low: meta.regularMarketDayLow ?? null,
        week52_high: meta.fiftyTwoWeekHigh ?? null,
        week52_low: meta.fiftyTwoWeekLow ?? null,
        volume: meta.regularMarketVolume ?? null,
        as_of: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
      },
      [url],
    );
  },
});

const history = new DynamicStructuredTool({
  name: 'yahoo_history',
  description:
    'Historical OHLC price bars for any listed security worldwide from Yahoo Finance. Free, no key, and reaches back decades. Use for charts, drawdowns, momentum and long-horizon behaviour on non-US listings.',
  schema: z.object({
    ticker: z.string().describe('TICKER.EXCHANGE or a bare US symbol.'),
    range: z
      .enum(['1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'])
      .default('1y')
      .describe('How far back to fetch.'),
    interval: z.enum(['1d', '1wk', '1mo']).default('1d').describe('Bar size.'),
  }),
  func: async ({ ticker, range, interval }) => {
    const symbol = toYahooSymbol(ticker);
    const { meta, timestamps, quote: q, url } = await fetchChart(
      symbol,
      { interval, range },
      TTL_EOD_PRICES,
    );

    const bars = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? null,
      high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,
      close: q.close?.[i] ?? null,
      volume: q.volume?.[i] ?? null,
    })).filter((b) => b.close != null);

    return formatToolResult(
      {
        ticker: ticker.toUpperCase(),
        yahoo_symbol: symbol,
        currency: meta.currency ?? null,
        exchange: meta.fullExchangeName ?? meta.exchangeName ?? null,
        interval,
        range,
        count: bars.length,
        bars,
      },
      [url],
    );
  },
});

/**
 * Monthly closes for the grading engine, back as far as the listing goes.
 *
 * The grader's primary price source is Tiingo, whose free tier allows about
 * 50 requests an hour — a 50-name universe report exhausts it partway through.
 * Losing prices silently costs the short horizon 36% of its weight (valuation
 * vs own history, momentum, relative strength) and makes the surviving grades
 * incomparable with each other, so the ranking degrades without ever failing.
 * Yahoo needs no key and has no such ceiling.
 */
export async function fetchMonthlyCloses(
  ticker: string,
): Promise<{ prices: Array<{ date: string; close: number }>; url: string }> {
  const symbol = toYahooSymbol(ticker);
  const { timestamps, quote: q, url } = await fetchChart(
    symbol,
    { interval: '1mo', range: 'max' },
    TTL_EOD_PRICES,
  );
  const prices = timestamps
    .map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      close: q.close?.[i] ?? null,
    }))
    .filter((p): p is { date: string; close: number } => typeof p.close === 'number');
  if (prices.length === 0) throw new Error(`[Yahoo Finance] no price history for ${ticker}`);
  return { prices, url };
}

export function getLeaves(): StructuredToolInterface[] | null {
  // No key required, so this provider is always available.
  return [quote, history];
}

export const yahooQuote = quote;
export const yahooHistory = history;
