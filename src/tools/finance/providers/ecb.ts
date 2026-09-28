/**
 * ECB (European Central Bank) SDMX REST API.
 * Docs: https://data-api.ecb.europa.eu/
 * Free, no key required. Returns XML by default — we set `format=jsondata` to get JSON.
 *
 * Coverage:
 *   - Policy rates: main refinancing operations, deposit facility, marginal lending
 *   - HICP (consumer prices) — eurozone + EU member states
 *   - EUR exchange rates vs 30+ currencies
 *   - Money supply (M1, M2, M3)
 *
 * Key series IDs:
 *   FM.B.U2.EUR.4F.KR.DF.LEV  - ECB deposit facility rate
 *   FM.B.U2.EUR.4F.KR.MF.LEV  - ECB main refinancing rate
 *   FM.B.U2.EUR.4F.KR.ML.LEV  - ECB marginal lending rate
 *   ICP.M.U2.N.000000.4.ANR    - Eurozone HICP YoY (most cited inflation print)
 *   EXR.D.USD.EUR.SP00.A       - EUR/USD daily reference rate
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_INTRADAY_QUOTE, TTL_FUNDAMENTALS } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

const LABEL = 'ECB';
const BASE_URL = 'https://data-api.ecb.europa.eu/service/data';

/** Curated list of useful series. Agent can pass any other series ID too. */
const KNOWN_SERIES: Record<string, string> = {
  'ecb.deposit': 'FM.B.U2.EUR.4F.KR.DFR.LEV',
  'ecb.refi': 'FM.B.U2.EUR.4F.KR.MRR_FR.LEV',
  'ecb.marginal': 'FM.B.U2.EUR.4F.KR.MLFR.LEV',
  'ecb.hicp.yoy': 'ICP.M.U2.N.000000.4.ANR',
  'fx.eurusd': 'EXR.D.USD.EUR.SP00.A',
  'fx.eurgbp': 'EXR.D.GBP.EUR.SP00.A',
  'fx.eurjpy': 'EXR.D.JPY.EUR.SP00.A',
  'fx.eurcny': 'EXR.D.CNY.EUR.SP00.A',
};

async function callEcb(seriesKey: string, ttlMs: number, title?: string): Promise<string> {
  const series = KNOWN_SERIES[seriesKey] ?? seriesKey;
  // SDMX wants the dataflow as its own path segment: EXR/D.USD.EUR.SP00.A, not
  // EXR.D.USD.EUR.SP00.A. Every ECB call was returning 400 without this split.
  const firstDot = series.indexOf('.');
  const path = firstDot === -1 ? series : `${series.slice(0, firstDot)}/${series.slice(firstDot + 1)}`;
  const url = `${BASE_URL}/${path}?format=jsondata&lastNObservations=60&detail=dataonly`;
  const result = await callProvider({
    provider: 'ecb', endpoint: series.replace(/[/.]/g, '_'),
    params: { series: seriesKey },
    url, ttlMs,
  });
  const sources: SourceRef[] = result.sourceUrls.map((u, i) => ({ id: i + 1, url: u, provider: 'ecb', title }));
  return JSON.stringify({
    data: result.data, sourceUrls: result.sourceUrls, sources,
    provider: 'ecb', asOf: result.asOf, cached: result.cached,
  });
}

const policyRate = new DynamicStructuredTool({
  name: 'ecb_policy_rate',
  description: 'ECB policy rates (deposit facility, main refinancing, marginal lending). Free, no key.',
  schema: z.object({
    rate: z.enum(['deposit', 'refi', 'marginal'])
      .default('deposit')
      .describe('Which ECB rate: deposit (DF), main refinancing (MRO), or marginal lending (MLF).'),
  }),
  func: async ({ rate }) => callEcb(`ecb.${rate === 'deposit' ? 'deposit' : rate === 'refi' ? 'refi' : 'marginal'}`, TTL_INTRADAY_QUOTE, `ECB ${rate} rate`),
});

const hicp = new DynamicStructuredTool({
  name: 'ecb_hicp',
  description: 'Eurozone HICP (consumer price inflation) YoY time series. Free, no key.',
  schema: z.object({}),
  func: async () => callEcb('ecb.hicp.yoy', TTL_FUNDAMENTALS, 'Eurozone HICP YoY'),
});

const fxRate = new DynamicStructuredTool({
  name: 'ecb_fx_rate',
  description: 'ECB reference FX rate for a currency pair (base=EUR). Free, no key.',
  schema: z.object({
    pair: z.string().describe('Currency pair, e.g. "EURUSD", "EURGBP", "EURJPY" (base must be EUR).'),
  }),
  func: async ({ pair }) => {
    const upper = pair.toUpperCase();
    const key = `fx.eur${upper.replace(/^EUR/, '').toLowerCase()}`;
    return callEcb(key, TTL_INTRADAY_QUOTE, `ECB FX ${upper}`);
  },
});

export function getLeaves(): StructuredToolInterface[] | null {
  // Always available — no key required
  return [policyRate, hicp, fxRate];
}

export { KNOWN_SERIES as _ecbKnownSeriesForTest };