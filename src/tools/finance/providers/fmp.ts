/**
 * Financial Modeling Prep — fundamentals, ratios, DCF, transcripts.
 * Docs: https://site.financialmodelingprep.com/developer/docs
 * Activated when FMP_API_KEY is set.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_FUNDAMENTALS } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

const LABEL = 'FMP';

/**
 * FMP retired the /api/v3 endpoints for accounts created after 2025-08-31; every
 * call to them now returns "Legacy Endpoint" instead of data, which is what this
 * provider was doing. /stable is the replacement, and it takes the ticker as a
 * `symbol` query parameter rather than a path segment.
 */
const BASE_URL = 'https://financialmodelingprep.com/stable';

/** The current plan rejects limit > 5 outright, so clamp rather than 400. */
const MAX_LIMIT = 5;

function clampLimit(limit: number): string {
  return String(Math.min(limit, MAX_LIMIT));
}

function apiKey(): string {
  const k = process.env.FMP_API_KEY;
  if (!k) throw new Error(`[${LABEL}] FMP_API_KEY not set`);
  return k;
}

async function callFmp(path: string, params: Record<string, string>, title?: string): Promise<string> {
  const url = new URL(`${BASE_URL}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apikey', apiKey());
  const result = await callProvider({
    provider: 'fmp', endpoint: path.replace(/\//g, '_'),
    params, url: url.toString(), ttlMs: TTL_FUNDAMENTALS,
  });
  const sources: SourceRef[] = result.sourceUrls.map((u, i) => ({ id: i + 1, url: u, provider: LABEL, title }));
  return JSON.stringify({
    data: result.data, sourceUrls: result.sourceUrls, sources,
    provider: LABEL, asOf: result.asOf, cached: result.cached,
  });
}

const profile = new DynamicStructuredTool({
  name: 'fmp_company_profile',
  description: 'Company profile (price, beta, market cap, sector, CEO) from FMP.',
  schema: z.object({ ticker: z.string() }),
  func: async ({ ticker }) => callFmp('profile', { symbol: ticker.toUpperCase() }, `profile ${ticker.toUpperCase()}`),
});

const ratios = new DynamicStructuredTool({
  name: 'fmp_ratios',
  description: 'Comprehensive financial ratios (P/E, ROE, debt/equity, margins) from FMP.',
  schema: z.object({
    ticker: z.string(),
    period: z.enum(['annual', 'quarter']).default('annual'),
    limit: z.number().int().min(1).max(40).default(5),
  }),
  func: async ({ ticker, period, limit }) =>
    callFmp('ratios', { symbol: ticker.toUpperCase(), period, limit: clampLimit(limit) }, `ratios ${ticker.toUpperCase()}`),
});

const dcf = new DynamicStructuredTool({
  name: 'fmp_dcf_valuation',
  description: 'DCF intrinsic value estimate from FMP.',
  schema: z.object({ ticker: z.string() }),
  func: async ({ ticker }) => callFmp('discounted-cash-flow', { symbol: ticker.toUpperCase() }, `dcf ${ticker.toUpperCase()}`),
});

const incomeStatement = new DynamicStructuredTool({
  name: 'fmp_income_statement',
  description: 'Income statements (annual or quarterly) from FMP.',
  schema: z.object({
    ticker: z.string(),
    period: z.enum(['annual', 'quarter']).default('annual'),
    limit: z.number().int().min(1).max(40).default(5),
  }),
  func: async ({ ticker, period, limit }) =>
    callFmp('income-statement', { symbol: ticker.toUpperCase(), period, limit: clampLimit(limit) }, `income ${ticker.toUpperCase()}`),
});

const balanceSheet = new DynamicStructuredTool({
  name: 'fmp_balance_sheet',
  description: 'Balance sheets (annual or quarterly) from FMP.',
  schema: z.object({
    ticker: z.string(),
    period: z.enum(['annual', 'quarter']).default('annual'),
    limit: z.number().int().min(1).max(40).default(5),
  }),
  func: async ({ ticker, period, limit }) =>
    callFmp('balance-sheet-statement', { symbol: ticker.toUpperCase(), period, limit: clampLimit(limit) }, `balance ${ticker.toUpperCase()}`),
});

const earningsCalendar = new DynamicStructuredTool({
  name: 'fmp_earnings_calendar',
  description: 'Upcoming earnings calendar (date, ticker, EPS/revenue estimates) from FMP.',
  schema: z.object({ from: z.string().describe('Start YYYY-MM-DD'), to: z.string().describe('End YYYY-MM-DD') }),
  func: async ({ from, to }) => callFmp('earnings-calendar', { from, to }, `earnings calendar ${from}..${to}`),
});

const stockScreener = new DynamicStructuredTool({
  name: 'fmp_stock_screener',
  description: 'Screen stocks by criteria (market cap, price, beta, volume, sector, exchange) from FMP.',
  schema: z.object({
    market_cap_more_than: z.number().optional(),
    market_cap_less_than: z.number().optional(),
    price_more_than: z.number().optional(),
    price_less_than: z.number().optional(),
    beta_more_than: z.number().optional(),
    beta_less_than: z.number().optional(),
    volume_more_than: z.number().optional(),
    volume_less_than: z.number().optional(),
    sector: z.string().optional(),
    exchange: z.string().optional(),
    limit: z.number().int().min(1).max(1000).default(50),
  }),
  func: async (input) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined && v !== null) params[k] = String(v);
    }
    return callFmp('company-screener', params, 'fmp screener');
  },
});

const earningsSurprises = new DynamicStructuredTool({
  name: 'fmp_earnings_surprises',
  description: 'Historical earnings surprises (actual vs estimated EPS) from FMP.',
  schema: z.object({ ticker: z.string() }),
  func: async ({ ticker }) => callFmp('earnings', { symbol: ticker.toUpperCase() }, `earnings ${ticker.toUpperCase()}`),
});

const priceTarget = new DynamicStructuredTool({
  name: 'fmp_price_target',
  description: 'Analyst price target consensus (low/avg/high) from FMP.',
  schema: z.object({ ticker: z.string() }),
  func: async ({ ticker }) => callFmp('price-target-consensus', { symbol: ticker.toUpperCase() }, `price target ${ticker.toUpperCase()}`),
});

export function getLeaves(): StructuredToolInterface[] | null {
  if (!process.env.FMP_API_KEY) return null;
  return [profile, ratios, dcf, incomeStatement, balanceSheet, earningsCalendar, stockScreener, earningsSurprises, priceTarget];
}

export const fmpEarningsCalendar = earningsCalendar;
