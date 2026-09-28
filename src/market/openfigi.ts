import type { IsinMatch } from './yahoo.js';

/**
 * ISIN → exchange listings from OpenFIGI (free; OPENFIGI_API_KEY raises the rate
 * limit). Yahoo's own search often knows a single listing of a European ETF;
 * OpenFIGI knows them all. Its tickers are turned into Yahoo symbols here and
 * marked unverified: the importer confirms each with a Yahoo quote before use.
 */

/** Bloomberg exchange code → Yahoo suffix and Yahoo's exchange name. Main venues only. */
const VENUES: Record<string, { suffix: string; exchange: string }> = {
  GY: { suffix: '.DE', exchange: 'GER' },
  GR: { suffix: '.F', exchange: 'FRA' },
  GF: { suffix: '.F', exchange: 'FRA' },
  NA: { suffix: '.AS', exchange: 'AMS' },
  FP: { suffix: '.PA', exchange: 'PAR' },
  IM: { suffix: '.MI', exchange: 'MIL' },
  LN: { suffix: '.L', exchange: 'LSE' },
  SW: { suffix: '.SW', exchange: 'EBS' },
  SE: { suffix: '.SW', exchange: 'EBS' },
  UN: { suffix: '', exchange: 'NYQ' },
  UW: { suffix: '', exchange: 'NMS' },
  UA: { suffix: '', exchange: 'ASE' },
  UP: { suffix: '', exchange: 'PCX' },
};

export function figiToListings(data: { ticker?: string; exchCode?: string; securityType?: string }[]): IsinMatch[] {
  const out = new Map<string, IsinMatch>();
  const add = (symbol: string, exchange: string, quoteType: string) => {
    if (!out.has(symbol)) out.set(symbol, { symbol, exchange, quoteType, unverified: true });
  };
  for (const d of data) {
    const venue = d.exchCode ? VENUES[d.exchCode] : undefined;
    // Tickers with a space or slash are share classes Yahoo writes differently; skip rather than guess.
    if (!venue || !d.ticker || /[\s/]/.test(d.ticker)) continue;
    const quoteType = /ETP|ETF|Fund/i.test(d.securityType ?? '') ? 'ETF' : 'EQUITY';
    add(`${d.ticker}${venue.suffix}`, venue.exchange, quoteType);
    // A Frankfurt ticker is usually the Xetra one too, and Xetra has the volume.
    if (venue.exchange === 'FRA') add(`${d.ticker}.DE`, 'GER', quoteType);
  }
  return [...out.values()];
}

export async function openFigiListings(isin: string): Promise<IsinMatch[]> {
  try {
    const call = (key?: string) => fetch('https://api.openfigi.com/v3/mapping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(key ? { 'X-OPENFIGI-APIKEY': key } : {}) },
      body: JSON.stringify([{ idType: 'ID_ISIN', idValue: isin }]),
      signal: AbortSignal.timeout(15_000),
    });
    const key = process.env.OPENFIGI_API_KEY?.trim();
    let res = await call(key);
    // A rejected key must not cost the lookup: the keyless tier still answers.
    if (res.status === 401 && key) res = await call();
    if (!res.ok) return [];
    const [first] = (await res.json()) as { data?: any[] }[];
    return figiToListings(first?.data ?? []);
  } catch {
    return [];
  }
}
