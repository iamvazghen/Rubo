/**
 * BIS (Bank for International Settlements) — cross-country central bank policy rates.
 * Free SDMX API: https://data.bis.org/
 *
 * Coverage: official policy rates for ~30 central banks (Fed, ECB, BoE, BoJ, BoC,
 * RBA, RBNZ, PBoC, RBI, etc.). Useful for global macro comparisons.
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_INTRADAY_QUOTE } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

const LABEL = 'BIS';
const BASE_URL = 'https://stats.bis.org/api/v2/data/dataflow/BIS';

async function callBis(series: string, ttlMs: number, title?: string): Promise<string> {
  // v1 was retired and answers 406 to everything; v2 additionally requires an
  // explicit SDMX Accept header or it also returns 406.
  const url = `${BASE_URL}/${series}?lastNObservations=120`;
  const result = await callProvider({
    provider: 'bis', endpoint: series.replace(/[/.]/g, '_'),
    params: { series },
    url, ttlMs,
    headers: { Accept: 'application/vnd.sdmx.data+json;version=1.0.0' },
  });
  const sources: SourceRef[] = result.sourceUrls.map((u, i) => ({ id: i + 1, url: u, provider: 'bis', title }));
  return JSON.stringify({
    data: result.data, sourceUrls: result.sourceUrls, sources,
    provider: 'bis', asOf: result.asOf, cached: result.cached,
  });
}

const centralBankRate = new DynamicStructuredTool({
  name: 'bis_central_bank_rate',
  description: 'BIS central bank policy rate time series for any of 30+ countries (Fed, ECB, BoE, BoJ, BoC, RBA, RBNZ, etc.). Free, no key.',
  schema: z.object({
    country: z
      .enum(['US','GB','JP','CA','AU','NZ','CH','SE','NO','DK','EA'])
      .default('US')
      .describe('ISO-2 country code (US=Fed, GB=BoE, JP=BoJ, CA=BoC, AU=RBA, NZ=RBNZ, CH=SNB, SE=Riksbank, NO=Norges, DK=Denmark, EA=EurArea/ECB).'),
  }),
  func: async ({ country }) =>
    callBis(`WS_CBPOL/1.0/D.${country}`, TTL_INTRADAY_QUOTE, `BIS ${country} policy rate`),
});

export function getLeaves(): StructuredToolInterface[] | null {
  return [centralBankRate];
}
