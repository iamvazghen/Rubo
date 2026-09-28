/**
 * Alpha Vantage — equities, FX, crypto, commodities, technical indicators.
 * Docs: https://www.alphavantage.co/documentation/
 * Activated when ALPHA_VANTAGE_API_KEY is set.
 *
 * Every call flows through `callProvider` for disk caching + freshness stamps.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_INTRADAY_QUOTE, TTL_EOD_PRICES, TTL_NEWS } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

// The free plan allows 25 API calls a day across every Alpha Vantage tool
// combined - roughly one research session. finnhub_quote and yahoo_quote have
// far higher ceilings; spend Alpha Vantage on what only it covers, which here
// is commodities.
const LABEL = 'Alpha Vantage';
const BASE_URL = 'https://www.alphavantage.co/query';

function apiKey(): string {
  const k = process.env.ALPHA_VANTAGE_API_KEY;
  if (!k) throw new Error(`[${LABEL}] ALPHA_VANTAGE_API_KEY not set`);
  return k;
}

function wrap(result: Awaited<ReturnType<typeof callProvider>>, providerName: string, title?: string): string {
  const sources: SourceRef[] = result.sourceUrls.map((u, i) => ({
    id: i + 1,
    url: u,
    provider: providerName,
    title,
  }));
  return JSON.stringify({
    data: result.data,
    sourceUrls: result.sourceUrls,
    sources,
    provider: providerName,
    asOf: result.asOf,
    cached: result.cached,
  });
}

const stockQuote = new DynamicStructuredTool({
  name: 'alphavantage_stock_quote',
  description: 'Latest stock quote (price, volume, day high/low) from Alpha Vantage.',
  schema: z.object({ ticker: z.string().describe('Stock ticker, e.g. AAPL') }),
  func: async ({ ticker }) => {
    const upper = ticker.toUpperCase();
    const url = `${BASE_URL}?function=GLOBAL_QUOTE&symbol=${upper}&apikey=${apiKey()}`;
    const result = await callProvider({
      provider: 'alphavantage', endpoint: 'stock_quote', params: { ticker: upper }, url,
      ttlMs: TTL_INTRADAY_QUOTE,
    });
    return wrap(result, 'Alpha Vantage', `GLOBAL_QUOTE ${upper}`);
  },
});

const stockTimeSeries = new DynamicStructuredTool({
  name: 'alphavantage_stock_time_series',
  description: 'Daily OHLCV time series for a stock from Alpha Vantage (compact=100 points, full=20+ years).',
  schema: z.object({
    ticker: z.string().describe('Stock ticker, e.g. AAPL'),
    outputsize: z.enum(['compact', 'full']).default('compact'),
  }),
  func: async ({ ticker, outputsize }) => {
    const upper = ticker.toUpperCase();
    const url = `${BASE_URL}?function=TIME_SERIES_DAILY&symbol=${upper}&outputsize=${outputsize}&apikey=${apiKey()}`;
    const result = await callProvider({
      provider: 'alphavantage', endpoint: 'stock_time_series',
      params: { ticker: upper, outputsize }, url,
      ttlMs: TTL_EOD_PRICES,
    });
    return wrap(result, 'Alpha Vantage', `TIME_SERIES_DAILY ${upper}`);
  },
});

const fxRate = new DynamicStructuredTool({
  name: 'alphavantage_fx_rate',
  description: 'Latest FX exchange rate between two currencies from Alpha Vantage.',
  schema: z.object({ from_currency: z.string(), to_currency: z.string() }),
  func: async ({ from_currency, to_currency }) => {
    const url = `${BASE_URL}?function=CURRENCY_EXCHANGE_RATE&from_currency=${from_currency.toUpperCase()}&to_currency=${to_currency.toUpperCase()}&apikey=${apiKey()}`;
    const result = await callProvider({
      provider: 'alphavantage', endpoint: 'fx_rate',
      params: { from: from_currency.toUpperCase(), to: to_currency.toUpperCase() }, url,
      ttlMs: TTL_INTRADAY_QUOTE,
    });
    return wrap(result, 'Alpha Vantage', `FX ${from_currency}/${to_currency}`);
  },
});

const cryptoRate = new DynamicStructuredTool({
  name: 'alphavantage_crypto_rating',
  description: 'Latest crypto exchange rate (e.g. BTC in USD) from Alpha Vantage.',
  schema: z.object({ symbol: z.string().describe('Crypto symbol, e.g. BTC'), market: z.string().default('USD') }),
  func: async ({ symbol, market }) => {
    const sym = symbol.toUpperCase();
    const mkt = market.toUpperCase();
    const url = `${BASE_URL}?function=CURRENCY_EXCHANGE_RATE&from_currency=${sym}&to_currency=${mkt}&apikey=${apiKey()}`;
    const result = await callProvider({
      provider: 'alphavantage', endpoint: 'crypto_rate',
      params: { symbol: sym, market: mkt }, url,
      ttlMs: TTL_INTRADAY_QUOTE,
    });
    return wrap(result, 'Alpha Vantage', `Crypto ${sym}/${mkt}`);
  },
});

const commodityPrice = new DynamicStructuredTool({
  name: 'alphavantage_commodity',
  description: 'Latest daily price for a commodity (WTI, BRENT, NATURAL_GAS, COPPER, WHEAT, CORN, SUGAR, COFFEE, etc.) from Alpha Vantage.',
  schema: z.object({
    commodity: z
      .enum(['WTI','BRENT','NATURAL_GAS','COPPER','ALUMINUM','WHEAT','CORN','COTTON','SUGAR','COFFEE','COCOA','LUMBER','LEAN_HOGS','LIVE_CATTLE','ALL_COMMODITIES'])
      .default('WTI')
      .describe('Which commodity to fetch.'),
    interval: z.enum(['daily','weekly','monthly']).default('daily'),
  }),
  func: async ({ commodity, interval }) => {
    const url = `${BASE_URL}?function=${commodity}&interval=${interval}&apikey=${apiKey()}`;
    const result = await callProvider({
      provider: 'alphavantage', endpoint: 'commodity',
      params: { commodity, interval }, url,
      ttlMs: TTL_EOD_PRICES,
    });
    return wrap(result, 'Alpha Vantage', `${commodity} ${interval}`);
  },
});

export function getLeaves(): StructuredToolInterface[] | null {
  if (!process.env.ALPHA_VANTAGE_API_KEY) return null;
  return [stockQuote, stockTimeSeries, fxRate, cryptoRate, commodityPrice];
}

export const alphavantageCommodity = commodityPrice;