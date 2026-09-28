import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { formatToolResult } from '../types.js';
import { fetchJson } from './utils.js';

/**
 * Additional financial-market integrations backed by free, key-less public APIs:
 *   - Foreign-exchange rates  → Frankfurter (European Central Bank reference rates)
 *   - Macroeconomic indicators → World Bank Open Data
 *   - US macro time series     → FRED (St. Louis Fed) — gated by FRED_API_KEY
 *
 * These broaden Rubo's coverage beyond the equities/crypto data provided by
 * Financial Datasets. FX and World Bank need no key; FRED is opt-in via .env.
 */

// ---------------------------------------------------------------------------
// Foreign exchange rates (Frankfurter — ECB reference rates, no API key)
// ---------------------------------------------------------------------------

export const FX_RATES_DESCRIPTION = `
Fetches foreign-exchange (currency) rates from the European Central Bank via Frankfurter. Use for:
- Current exchange rates between currencies (e.g., USD→EUR, GBP→JPY)
- Historical rates on a specific date
- A time series of rates across a date range

Covers major world currencies (USD, EUR, GBP, JPY, CHF, CAD, AUD, CNY, etc.). No API key required.
`.trim();

const FxRatesInputSchema = z.object({
  base: z
    .string()
    .default('USD')
    .describe("Base currency ISO code (e.g., 'USD', 'EUR'). Defaults to USD."),
  symbols: z
    .array(z.string())
    .optional()
    .describe("Target currency ISO codes to convert into (e.g., ['EUR','GBP']). Omit for all."),
  date: z
    .string()
    .optional()
    .describe('Single historical date in YYYY-MM-DD for a point-in-time rate.'),
  start_date: z
    .string()
    .optional()
    .describe('Start date (YYYY-MM-DD) for a time series. Use with end_date.'),
  end_date: z
    .string()
    .optional()
    .describe('End date (YYYY-MM-DD) for a time series. Use with start_date.'),
});

export const getFxRates = new DynamicStructuredTool({
  name: 'get_fx_rates',
  description:
    'Fetches foreign-exchange (currency) rates: latest, historical on a date, or a time series over a range. Powered by the European Central Bank (Frankfurter). No key required.',
  schema: FxRatesInputSchema,
  func: async (input) => {
    const base = input.base.trim().toUpperCase();
    const symbols = input.symbols?.map((s) => s.trim().toUpperCase()).filter(Boolean) ?? [];

    let path: string;
    if (input.start_date && input.end_date) {
      path = `${input.start_date}..${input.end_date}`;
    } else if (input.date) {
      path = input.date;
    } else {
      path = 'latest';
    }

    const url = new URL(`https://api.frankfurter.app/${path}`);
    url.searchParams.set('base', base);
    if (symbols.length > 0) {
      url.searchParams.set('symbols', symbols.join(','));
    }

    const data = await fetchJson(url.toString(), 'Frankfurter FX');
    return formatToolResult(data as Record<string, unknown>, [url.toString()]);
  },
});

// ---------------------------------------------------------------------------
// Macroeconomic indicators (World Bank Open Data, no API key)
// ---------------------------------------------------------------------------

const INDICATOR_CODES: Record<string, { code: string; label: string }> = {
  gdp: { code: 'NY.GDP.MKTP.CD', label: 'GDP (current US$)' },
  gdp_growth: { code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth (annual %)' },
  gdp_per_capita: { code: 'NY.GDP.PCAP.CD', label: 'GDP per capita (current US$)' },
  inflation: { code: 'FP.CPI.TOTL.ZG', label: 'Inflation, consumer prices (annual %)' },
  unemployment: { code: 'SL.UEM.TOTL.ZS', label: 'Unemployment, total (% of labor force)' },
  interest_rate: { code: 'FR.INR.RINR', label: 'Real interest rate (%)' },
  population: { code: 'SP.POP.TOTL', label: 'Population, total' },
  government_debt: { code: 'GC.DOD.TOTL.GD.ZS', label: 'Central government debt, total (% of GDP)' },
};

export const ECONOMIC_INDICATORS_DESCRIPTION = `
Fetches macroeconomic indicators for a country from World Bank Open Data. Use for:
- GDP, GDP growth, GDP per capita
- Inflation (consumer prices)
- Unemployment rate
- Real interest rate, government debt, population

Supports a year range. Country accepts ISO-2 or ISO-3 codes (e.g., 'US', 'USA', 'DE', 'CN'). No API key required.
`.trim();

const EconomicIndicatorsInputSchema = z.object({
  country: z
    .string()
    .default('US')
    .describe("Country code, ISO-2 or ISO-3 (e.g., 'US', 'USA', 'DE', 'CN'). Defaults to US."),
  indicator: z
    .enum([
      'gdp',
      'gdp_growth',
      'gdp_per_capita',
      'inflation',
      'unemployment',
      'interest_rate',
      'population',
      'government_debt',
    ])
    .describe('Which macroeconomic indicator to retrieve.'),
  start_year: z
    .number()
    .optional()
    .describe('First year of data (e.g., 2015). Defaults to the last 10 years.'),
  end_year: z.number().optional().describe('Last year of data (e.g., 2024).'),
});

export const getEconomicIndicators = new DynamicStructuredTool({
  name: 'get_economic_indicators',
  description:
    'Fetches macroeconomic indicators (GDP, inflation, unemployment, interest rates, debt, population) for a country from World Bank Open Data. No key required.',
  schema: EconomicIndicatorsInputSchema,
  func: async (input) => {
    const mapping = INDICATOR_CODES[input.indicator];
    const country = input.country.trim().toUpperCase();
    const currentYear = new Date().getFullYear();
    const endYear = input.end_year ?? currentYear;
    const startYear = input.start_year ?? endYear - 10;

    const url = new URL(
      `https://api.worldbank.org/v2/country/${encodeURIComponent(country)}/indicator/${mapping.code}`,
    );
    url.searchParams.set('format', 'json');
    url.searchParams.set('date', `${startYear}:${endYear}`);
    url.searchParams.set('per_page', '100');

    const raw = await fetchJson(url.toString(), 'World Bank');
    // World Bank returns [paginationMeta, dataArray]
    const series = Array.isArray(raw) && Array.isArray(raw[1]) ? raw[1] : [];
    const observations = (series as Array<Record<string, unknown>>)
      .map((row) => ({
        year: row.date,
        value: row.value,
        country: (row.country as { value?: string } | undefined)?.value,
      }))
      .filter((row) => row.value !== null && row.value !== undefined);

    return formatToolResult(
      {
        indicator: mapping.label,
        indicatorCode: mapping.code,
        country,
        observations,
      },
      [url.toString()],
    );
  },
});

// ---------------------------------------------------------------------------
// FRED — US Federal Reserve Economic Data (St. Louis Fed)
//
// FRED carries ~841,000 series and the key is free and unmetered. This used to
// expose exactly nine of them through a Zod enum, so the agent could not fetch
// German CPI, a foreign policy rate, a credit spread or a mortgage rate at all —
// it would answer that the data was unavailable. `series` now accepts a raw FRED
// ID as well as a friendly alias, and fred_search finds the ID.
// ---------------------------------------------------------------------------

const FRED_SERIES: Record<string, { code: string; label: string; units?: string }> = {
  fed_funds: { code: 'DFF', label: 'Federal Funds Effective Rate', units: 'percent' },
  sofr: { code: 'SOFR', label: 'Secured Overnight Financing Rate', units: 'percent' },
  cpi: { code: 'CPIAUCSL', label: 'Consumer Price Index (All Urban Consumers)', units: 'index' },
  cpi_yoy: { code: 'CPIAUCSL', label: 'CPI, year-over-year % change', units: 'percent' },
  treasury_2y: { code: 'DGS2', label: '2-Year Treasury Constant Maturity Rate', units: 'percent' },
  treasury_10y: { code: 'DGS10', label: '10-Year Treasury Constant Maturity Rate', units: 'percent' },
  treasury_30y: { code: 'DGS30', label: '30-Year Treasury Constant Maturity Rate', units: 'percent' },
  real_yield_10y: { code: 'DFII10', label: '10-Year TIPS (real) Yield', units: 'percent' },
  yield_curve_10y_2y: { code: 'T10Y2Y', label: '10Y minus 2Y Treasury Spread', units: 'percent' },
  hy_spread: { code: 'BAMLH0A0HYM2', label: 'ICE BofA US High Yield Option-Adjusted Spread', units: 'percent' },
  ig_spread: { code: 'BAMLC0A0CM', label: 'ICE BofA US Corporate Option-Adjusted Spread', units: 'percent' },
  mortgage_30y: { code: 'MORTGAGE30US', label: '30-Year Fixed Rate Mortgage Average', units: 'percent' },
  unemployment: { code: 'UNRATE', label: 'Unemployment Rate', units: 'percent' },
  gdp: { code: 'GDP', label: 'Gross Domestic Product', units: 'billions of $' },
  pce: { code: 'PCEPI', label: 'Personal Consumption Expenditures Price Index', units: 'index' },
  m2: { code: 'M2SL', label: 'M2 Money Stock', units: 'billions of $' },
};

const FRED_ALIASES = Object.keys(FRED_SERIES);

/** FRED's own server-side transforms — cheaper and more correct than recomputing. */
const FredUnits = z
  .enum(['lin', 'chg', 'ch1', 'pch', 'pc1', 'pca', 'cch', 'cca', 'log'])
  .optional()
  .describe(
    'FRED transform: lin (as published, default), pc1 (% change from a year ago), pch (% change from previous period), chg (change), log. Use pc1 to turn any index into a year-over-year rate.',
  );

export const FRED_DESCRIPTION = `
Fetches any of the ~841,000 US Federal Reserve Economic Data (FRED) series.

## Picking a series
Pass either a friendly alias or a raw FRED series ID.

Aliases: ${FRED_ALIASES.join(', ')}.

Raw IDs cover everything else, including non-US data: DEXUSEU (USD/EUR),
IRLTLT01DEM156N (German 10y government yield), CPALTT01DEM659N (German CPI),
IRSTCI01JPM156N (Japan policy rate), NYGDPPCAPKDARM (Armenia GDP per capita).
Use \`fred_search\` when you do not know the ID — never guess one.

## Transforms
\`units\` applies FRED's own transform: 'pc1' gives year-over-year % change,
'pch' period-over-period. Prefer this over fetching levels and doing the
arithmetic yourself.

Requires FRED_API_KEY. Free and unmetered.
`.trim();

const FredInputSchema = z.object({
  series: z
    .string()
    .describe(
      `A FRED alias (${FRED_ALIASES.slice(0, 6).join(', ')}, ...) or a raw FRED series ID such as 'MORTGAGE30US' or 'IRLTLT01DEM156N'.`,
    ),
  start_date: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to 5 years ago.'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
  units: FredUnits,
});

/** An alias, or a raw FRED ID the caller supplied. */
export function resolveFredSeries(input: string): {
  code: string;
  label: string;
  units?: string;
  alias?: string;
} {
  const alias = FRED_SERIES[input.toLowerCase()];
  if (alias) return { ...alias, alias: input.toLowerCase() };
  return { code: input.toUpperCase(), label: input.toUpperCase() };
}

function fredWindow(startDate?: string, endDate?: string) {
  const today = new Date();
  const start = startDate ?? `${today.getFullYear() - 5}-01-01`;
  const end = endDate ?? today.toISOString().slice(0, 10);
  return { start, end };
}

export function fredObservationsUrl(
  code: string,
  apiKey: string,
  start: string,
  end: string,
  units?: string,
) {
  const url = new URL('https://api.stlouisfed.org/fred/series/observations');
  url.searchParams.set('series_id', code);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_type', 'json');
  url.searchParams.set('observation_start', start);
  url.searchParams.set('observation_end', end);
  if (units && units !== 'lin') url.searchParams.set('units', units);
  return url;
}

function requireFredKey(): string {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) throw new Error('[FRED API] FRED_API_KEY is not set');
  return apiKey;
}

async function fetchFredObservations(url: URL) {
  const raw = (await fetchJson(url.toString(), 'FRED API')) as {
    observations?: Array<{ date: string; value: string }>;
  };
  // FRED writes '.' for a missing reading, and a transform blanks the first period.
  return (raw.observations ?? [])
    .filter((o) => o.value !== '.')
    .map((o) => ({ date: o.date, value: Number(o.value) }))
    .filter((o) => Number.isFinite(o.value));
}

export const getFredSeries = new DynamicStructuredTool({
  name: 'get_fred_series',
  description:
    'Fetches any FRED macroeconomic time series by alias or raw series ID — Fed funds, Treasury yields at every tenor, real yields, credit spreads, mortgage rates, CPI, unemployment, GDP, money supply, and non-US series such as German or Japanese rates. Supports FRED transforms (pc1 for year-over-year). Use fred_search to find an ID.',
  schema: FredInputSchema,
  func: async (input) => {
    const apiKey = requireFredKey();
    const meta = resolveFredSeries(input.series);
    const { start, end } = fredWindow(input.start_date, input.end_date);
    // The cpi_yoy alias means "CPI, as a rate", so it implies the transform.
    const units = input.units ?? (meta.alias === 'cpi_yoy' ? 'pc1' : undefined);
    const url = fredObservationsUrl(meta.code, apiKey, start, end, units);

    const observations = await fetchFredObservations(url);
    if (observations.length === 0) {
      throw new Error(
        `[FRED API] series "${input.series}" returned no observations in ${start}..${end}. Check the ID with fred_search.`,
      );
    }

    return formatToolResult(
      {
        series: input.series,
        series_id: meta.code,
        label: meta.label,
        units: units && units !== 'lin' ? `${meta.units ?? 'value'} (${units})` : meta.units,
        observations,
      },
      [url.toString()],
    );
  },
});

const FredMultiInputSchema = z.object({
  series: z
    .array(z.string())
    .min(2)
    .max(9)
    .describe(
      'Two to nine FRED aliases or raw series IDs, e.g. ["fed_funds", "treasury_10y", "MORTGAGE30US"].',
    ),
  start_date: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to 5 years ago.'),
  end_date: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
  units: FredUnits,
});

/**
 * Multi-series FRED fetch. Avoids the N-call fan-out when the user wants
 * a macro dashboard (rates + yields + inflation + spreads all at once).
 */
export const getFredSeriesMulti = new DynamicStructuredTool({
  name: 'get_fred_series_multi',
  description:
    'Fetches 2-9 FRED series in parallel and returns them as one combined payload. Use this for macro dashboards (policy rate + yield curve + inflation + credit spreads at once) instead of several get_fred_series calls.',
  schema: FredMultiInputSchema,
  func: async (input) => {
    const apiKey = requireFredKey();
    const { start, end } = fredWindow(input.start_date, input.end_date);

    const fetchOne = async (key: string) => {
      const meta = resolveFredSeries(key);
      const units = input.units ?? (meta.alias === 'cpi_yoy' ? 'pc1' : undefined);
      const url = fredObservationsUrl(meta.code, apiKey, start, end, units);
      try {
        const observations = await fetchFredObservations(url);
        return {
          key,
          url: url.toString(),
          series: { series_id: meta.code, label: meta.label, units: meta.units, observations },
        };
      } catch (error) {
        // One bad ID in a dashboard should not cost the caller the other eight series.
        return {
          key,
          url: url.toString(),
          series: { series_id: meta.code, label: meta.label, error: (error as Error).message },
        };
      }
    };

    const results = await Promise.all(input.series.map(fetchOne));
    const combined: Record<string, unknown> = {};
    for (const r of results) combined[r.key] = r.series;
    return formatToolResult(
      { from: start, to: end, series: combined },
      results.map((r) => r.url),
    );
  },
});

export const FRED_SEARCH_DESCRIPTION = `
Finds FRED series IDs by keyword, so get_fred_series can fetch them.

FRED holds ~841,000 series and the IDs are not guessable ('MORTGAGE30US',
'BAMLH0A0HYM2', 'IRLTLT01DEM156N'). Search first, then fetch — a guessed ID
returns an error, not data.

Results are ordered by popularity, which is usually what you want: the headline
series for a concept outranks its 400 regional variants. Each hit carries the
frequency, units and observation range, so you can tell a monthly index from a
daily rate before spending a call on it.
`.trim();

export const fredSearch = new DynamicStructuredTool({
  name: 'fred_search',
  description:
    'Searches the ~841,000 FRED series by keyword and returns their IDs, titles, frequency, units and date coverage. Use before get_fred_series whenever you do not already know the exact series ID — including for non-US data (German CPI, Japanese rates, emerging-market GDP).',
  schema: z.object({
    query: z
      .string()
      .describe(
        'Keywords, e.g. "30 year mortgage rate", "germany consumer price index", "high yield spread".',
      ),
    limit: z.number().int().min(1).max(50).default(10).describe('How many series to return.'),
  }),
  func: async (input) => {
    const apiKey = requireFredKey();
    const url = new URL('https://api.stlouisfed.org/fred/series/search');
    url.searchParams.set('search_text', input.query);
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('file_type', 'json');
    url.searchParams.set('limit', String(input.limit));
    url.searchParams.set('order_by', 'popularity');
    url.searchParams.set('sort_order', 'desc');

    const raw = (await fetchJson(url.toString(), 'FRED API')) as {
      seriess?: Array<Record<string, unknown>>;
    };
    const results = (raw.seriess ?? []).map((s) => ({
      series_id: s.id,
      title: s.title,
      frequency: s.frequency_short,
      units: s.units_short,
      seasonal_adjustment: s.seasonal_adjustment_short,
      observation_start: s.observation_start,
      observation_end: s.observation_end,
      popularity: s.popularity,
    }));
    return formatToolResult({ query: input.query, count: results.length, results }, [
      url.toString(),
    ]);
  },
});
