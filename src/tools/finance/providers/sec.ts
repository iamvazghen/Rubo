/**
 * SEC EDGAR — filings and XBRL fundamentals for US issuers. Free, no key, and
 * the primary source rather than a reseller.
 *
 * This exists because financialdatasets.ai — which backed get_financials,
 * get_market_data, read_filings and stock_screener — sits at a $0.00 balance and
 * returns "Insufficient credits" to everything. EDGAR is what those tools were
 * reselling in the first place.
 *
 * Two limits, stated plainly:
 *   - US issuers only. Non-US listings need Yahoo or a paid provider.
 *   - Companies tag the same idea with different XBRL concepts. Apple reports
 *     revenue as RevenueFromContractWithCustomerExcludingAssessedTax, not
 *     Revenues. So each metric tries a list of concepts in order rather than
 *     assuming one name, which is the trap that makes naive EDGAR code report
 *     "no data" for half the market.
 *
 * SEC requires a descriptive User-Agent and rate-limits to 10 requests/second.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_FUNDAMENTALS } from '../provider-call.js';
import { formatToolResult } from '../../types.js';

const LABEL = 'SEC EDGAR';

/** SEC asks for a contactable agent string; requests without one are refused. */
const HEADERS = {
  'User-Agent': process.env.SEC_USER_AGENT || 'Rubo Research rubo@example.com',
};

/** Metric -> XBRL concepts to try, in order of preference. */
const CONCEPTS: Record<string, string[]> = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'RevenueFromContractWithCustomerIncludingAssessedTax',
    'Revenues',
    'SalesRevenueNet',
  ],
  net_income: ['NetIncomeLoss', 'ProfitLoss'],
  operating_income: ['OperatingIncomeLoss'],
  gross_profit: ['GrossProfit'],
  assets: ['Assets'],
  liabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  eps_diluted: ['EarningsPerShareDiluted'],
  shares_diluted: ['WeightedAverageNumberOfDilutedSharesOutstanding'],
};

let tickerToCik: Map<string, string> | null = null;

/** SEC keys everything by CIK, so the ticker map is fetched once and cached. */
async function resolveCik(ticker: string): Promise<string> {
  if (!tickerToCik) {
    const res = await callProvider({
      provider: 'sec',
      endpoint: 'company_tickers',
      params: {},
      url: 'https://www.sec.gov/files/company_tickers.json',
      ttlMs: TTL_FUNDAMENTALS,
      headers: HEADERS,
    });
    const map = new Map<string, string>();
    for (const entry of Object.values(res.data as Record<string, { cik_str?: number; ticker?: string }>)) {
      if (entry?.ticker && entry.cik_str != null) {
        map.set(entry.ticker.toUpperCase(), String(entry.cik_str).padStart(10, '0'));
      }
    }
    tickerToCik = map;
  }

  const cik = tickerToCik.get(ticker.trim().toUpperCase());
  if (!cik) {
    throw new Error(
      `[${LABEL}] no SEC registrant for "${ticker}". EDGAR covers US issuers only — use yahoo_quote for a foreign listing.`,
    );
  }
  return cik;
}

interface ConceptPoint {
  end?: string;
  val?: number;
  form?: string;
  fy?: number;
  fp?: string;
}

async function fetchConcept(cik: string, concept: string): Promise<ConceptPoint[]> {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
  const res = await callProvider({
    provider: 'sec',
    endpoint: `concept_${concept}`,
    params: { cik },
    url,
    ttlMs: TTL_FUNDAMENTALS,
    headers: HEADERS,
  });
  const units = (res.data as { units?: Record<string, ConceptPoint[]> }).units ?? {};
  // USD for money, USD/shares for per-share, "shares" for counts.
  const series = units.USD ?? units['USD/shares'] ?? units.shares ?? [];
  return Array.isArray(series) ? series : [];
}

const financials = new DynamicStructuredTool({
  name: 'sec_financials',
  description:
    'Annual financial-statement figures for a US-listed company straight from SEC EDGAR XBRL filings. Free, no key, primary source. Returns revenue, net income, operating income, assets, equity, operating cash flow, capex and EPS by fiscal year. Use for US fundamentals; foreign listings are not covered.',
  schema: z.object({
    ticker: z.string().describe('US ticker, e.g. "AAPL".'),
    metrics: z
      .array(z.enum(Object.keys(CONCEPTS) as [string, ...string[]]))
      .optional()
      .describe('Which metrics to pull. Defaults to the core income-statement set.'),
    years: z.number().int().min(1).max(25).default(10).describe('How many fiscal years back.'),
  }),
  func: async ({ ticker, metrics, years }) => {
    const cik = await resolveCik(ticker);
    const wanted = metrics?.length
      ? metrics
      : ['revenue', 'net_income', 'operating_income', 'assets', 'equity', 'operating_cash_flow'];

    const out: Record<string, Array<{ fy: number; end: string; value: number }>> = {};
    const missing: string[] = [];

    for (const metric of wanted) {
      let points: ConceptPoint[] = [];
      let used = '';
      for (const concept of CONCEPTS[metric] ?? []) {
        try {
          points = await fetchConcept(cik, concept);
          if (points.length > 0) {
            used = concept;
            break;
          }
        } catch {
          // Concept not reported by this filer; try the next spelling.
        }
      }

      if (points.length === 0) {
        missing.push(metric);
        continue;
      }

      // Annual figures only, newest first, one row per fiscal year.
      const byYear = new Map<number, { fy: number; end: string; value: number }>();
      for (const p of points) {
        if (p.form !== '10-K' || p.fy == null || p.val == null || !p.end) continue;
        if (!byYear.has(p.fy)) byYear.set(p.fy, { fy: p.fy, end: p.end, value: p.val });
      }
      out[metric] = [...byYear.values()].sort((a, b) => b.fy - a.fy).slice(0, years);
      if (used) out[`${metric}__concept`] = out[metric];
    }

    return formatToolResult(
      {
        ticker: ticker.toUpperCase(),
        cik,
        source: 'SEC EDGAR XBRL (10-K)',
        metrics: out,
        not_reported: missing,
      },
      [`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/`],
    );
  },
});

const filings = new DynamicStructuredTool({
  name: 'sec_filings',
  description:
    'Index of a US company\'s SEC filings (10-K, 10-Q, 8-K, DEF 14A, Form 4 …) with dates and direct document URLs, from EDGAR. Free, no key. Use to find a filing, then read it with web_fetch.',
  schema: z.object({
    ticker: z.string().describe('US ticker, e.g. "AAPL".'),
    form: z.string().optional().describe('Filter by form type, e.g. "10-K", "8-K".'),
    limit: z.number().int().min(1).max(40).default(10),
  }),
  func: async ({ ticker, form, limit }) => {
    const cik = await resolveCik(ticker);
    const res = await callProvider({
      provider: 'sec',
      endpoint: 'submissions',
      params: { cik },
      url: `https://data.sec.gov/submissions/CIK${cik}.json`,
      ttlMs: TTL_FUNDAMENTALS,
      headers: HEADERS,
    });

    const data = res.data as {
      name?: string;
      filings?: {
        recent?: {
          form?: string[];
          filingDate?: string[];
          accessionNumber?: string[];
          primaryDocument?: string[];
          reportDate?: string[];
        };
      };
    };
    const recent = data.filings?.recent;
    const forms = recent?.form ?? [];

    const rows: Array<Record<string, string>> = [];
    for (let i = 0; i < forms.length && rows.length < limit; i++) {
      if (form && forms[i] !== form.toUpperCase()) continue;
      const accession = (recent?.accessionNumber?.[i] ?? '').replace(/-/g, '');
      rows.push({
        form: forms[i],
        filed: recent?.filingDate?.[i] ?? '',
        period: recent?.reportDate?.[i] ?? '',
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession}/${recent?.primaryDocument?.[i] ?? ''}`,
      });
    }

    return formatToolResult(
      { ticker: ticker.toUpperCase(), company: data.name ?? null, cik, count: rows.length, filings: rows },
      [`https://data.sec.gov/submissions/CIK${cik}.json`],
    );
  },
});

export function getLeaves(): StructuredToolInterface[] | null {
  // No key required.
  return [financials, filings];
}

export const secFinancials = financials;
export const secFilings = filings;
export { CONCEPTS as SEC_CONCEPTS };
