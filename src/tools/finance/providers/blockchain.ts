/**
 * Blockchain.com free REST API — on-chain Bitcoin stats.
 * Docs: https://www.blockchain.com/explorer/api/blockchain_api
 * No API key required.
 *
 * Endpoints used:
 *   /q/totalbc                    - total BTC supply (with halving not accounted)
 *   /q/circulating                - circulating BTC supply
 *   /q/getblockcount              - current block height
 *   /q/hashrate                   - network hash rate (TH/s)
 *   /q/getdifficulty              - current mining difficulty
 *   /q/totalbc/1d-conf-balance    - unconfirmed BTC balance on network
 *   /q/24hr                        - 24h transaction volume summary
 *   /q/marketcap                   - total BTC market cap (USD)
 *   /q/getnbtotalbtc               - BTC sent in last 24h
 *   /q/btcc                        - BTC transaction count, last 24h
 */
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';
import { callProvider, TTL_INTRADAY_QUOTE } from '../provider-call.js';
import { formatToolResult, type SourceRef } from '../../types.js';

const LABEL = 'Blockchain.com';
const BASE_URL = 'https://blockchain.info';

async function callBc(path: string, ttlMs: number, title: string): Promise<string> {
  const url = `${BASE_URL}${path}`;
  const result = await callProvider({
    provider: 'blockchain', endpoint: path.replace(/\//g, '_').slice(1) || 'root',
    params: { path },
    url, ttlMs,
  });
  const sources: SourceRef[] = result.sourceUrls.map((u, i) => ({ id: i + 1, url: u, provider: 'blockchain', title }));
  return JSON.stringify({
    data: result.data, sourceUrls: result.sourceUrls, sources,
    provider: 'blockchain', asOf: result.asOf, cached: result.cached,
  });
}

const supply = new DynamicStructuredTool({
  name: 'btc_supply',
  description: 'Bitcoin circulating + total supply + market cap from Blockchain.com (free, no key).',
  schema: z.object({}),
  func: async () => {
    // /q/circulating does not exist and 404s, which took the whole tool down.
    // blockchain.info reports mined supply as /q/totalbc, in satoshi; for
    // Bitcoin mined supply and circulating supply are the same number, so
    // there is nothing else to fetch.
    const [total, cap] = await Promise.all([
      callBc('/q/totalbc', TTL_INTRADAY_QUOTE, 'BTC total supply'),
      callBc('/q/marketcap', TTL_INTRADAY_QUOTE, 'BTC market cap USD'),
    ]);
    const totalSatoshi = Number(JSON.parse(total).data?.value ?? JSON.parse(total).data);
    const capData = JSON.parse(cap).data;
    const btc = Number.isFinite(totalSatoshi) ? totalSatoshi / 1e8 : null;
    return formatToolResult({
      total_supply_btc: btc,
      circulating_supply_btc: btc,
      max_supply_btc: 21_000_000,
      market_cap_usd: capData,
      as_of: new Date().toISOString(),
      source: 'blockchain.com',
    });
  },
});

const networkStats = new DynamicStructuredTool({
  name: 'btc_network_stats',
  description: 'Bitcoin network health (hash rate, difficulty, block height, 24h tx volume) from Blockchain.com (free, no key).',
  schema: z.object({}),
  func: async () => {
    const [hashrate, difficulty, height, volBtc, txCount] = await Promise.all([
      callBc('/q/hashrate', TTL_INTRADAY_QUOTE, 'BTC hash rate TH/s'),
      callBc('/q/getdifficulty', TTL_INTRADAY_QUOTE, 'BTC difficulty'),
      callBc('/q/getblockcount', TTL_INTRADAY_QUOTE, 'BTC block height'),
      callBc('/q/24hrbtcsent', TTL_INTRADAY_QUOTE, 'BTC sent 24h'),
      callBc('/q/24hrtransactioncount', TTL_INTRADAY_QUOTE, 'BTC tx count 24h'),
    ]);
    return formatToolResult({
      hash_rate_th_per_sec: JSON.parse(hashrate).data,
      difficulty: JSON.parse(difficulty).data,
      block_height: JSON.parse(height).data,
      btc_sent_last_24h: JSON.parse(volBtc).data,
      tx_count_last_24h: JSON.parse(txCount).data,
      as_of: new Date().toISOString(),
      source: 'blockchain.com',
    });
  },
});

export function getLeaves(): StructuredToolInterface[] | null {
  // Always available — no key required
  return [supply, networkStats];
}
