/**
 * Provider health check. Calls every network-backed tool once with a realistic
 * argument set and reports what actually comes back.
 *
 * This exists because unit tests could not catch the failure it was written for.
 * The ECB tools shipped with a URL the API answers 400 to, and the ECB unit test
 * passed the whole time — it asserted that a series ID started with "FM.B.U2",
 * which was true and useless. Six tools were dead in the registry for two
 * months. A dead tool is worse than a missing one: the agent spends a turn on it
 * and reports "I could not get that data" instead of falling back.
 *
 * Not a unit test: it makes real API calls, costs quota, and depends on the
 * network. Run it deliberately — `bun run health` — after touching a provider
 * or when the agent starts saying data is unavailable.
 */
import 'dotenv/config';
import { getToolRegistry } from '../tools/registry.js';
import { DEFAULT_MODEL } from '../model/llm.js';

/** One realistic call per tool. Tools absent from this list are reported as unchecked. */
const FIXTURES: Record<string, Record<string, unknown>> = {
  // --- grading engine
  grade_ticker: { ticker: 'AAPL', record: false },
  score_history: { action: 'universe' },
  screen_universe: {
    filters: [{ metric: 'roe', operator: 'gt', value: 10 }],
    tickers: ['AAPL', 'MSFT'],
    limit: 5,
  },

  // --- meta tools (financialdatasets.ai backed)
  get_financials: { query: 'AAPL revenue last year' },
  get_market_data: { query: 'AAPL stock price' },
  get_catalyst_calendar: { ticker: 'AAPL' },
  get_global_stock: { ticker: 'VOD.LSE' },

  // --- holdings, income and rebalancing (read-only calls; state is the owner's)
  income_calendar: {},
  yield_plan: { action: 'show' },
  tax_profile: { action: 'show' },
  reserve_balance: { action: 'show' },
  rebalance_targets: { command: '' },
  rebalance_proposal: {},

  // --- Jev (TypeSafe); answers are cached, so a repeat sweep costs nothing
  dividend_safety: { ticker: 'KO' },
  news_materiality: { ticker: 'KO', news: '2026-07-21, Reuters: Coca-Cola raises full-year organic revenue growth guidance to 6 %.' },

  // --- macro
  get_fred_series: { series: 'fed_funds' },
  fred_search: { query: '30 year mortgage rate', limit: 3 },
  get_fred_series_multi: { series: ['fed_funds', 'treasury_10y'] },
  get_fx_rates: { base: 'EUR', symbols: ['USD'] },
  get_economic_indicators: { country: 'DE', indicator: 'gdp' },
  ecb_policy_rate: { rate: 'deposit' },
  ecb_hicp: {},
  ecb_fx_rate: { pair: 'EURUSD' },
  bis_central_bank_rate: { country: 'US' },

  // --- equity providers
  finnhub_quote: { ticker: 'AAPL' },
  finnhub_company_profile: { ticker: 'AAPL' },
  finnhub_peers: { ticker: 'AAPL' },
  finnhub_recommendation: { ticker: 'AAPL' },
  fmp_company_profile: { ticker: 'AAPL' },
  fmp_ratios: { ticker: 'AAPL', period: 'annual', limit: 3 },
  fmp_income_statement: { ticker: 'AAPL', period: 'annual', limit: 3 },
  fmp_balance_sheet: { ticker: 'AAPL', period: 'annual', limit: 3 },
  fmp_dcf_valuation: { ticker: 'AAPL' },
  fmp_price_target: { ticker: 'AAPL' },
  fmp_stock_screener: { market_cap_more_than: 1e9, limit: 2 },
  tiingo_eod_prices: { ticker: 'AAPL', start_date: '2026-08-01', end_date: '2026-09-01' },
  tiingo_fundamentals: { ticker: 'AAPL' },
  polygon_stock_snapshot: { ticker: 'AAPL' },
  eodhd_eod_prices: { ticker: 'AAPL.US', start_date: '2026-08-01', end_date: '2026-09-01' },
  eodhd_fundamentals: { ticker: 'AAPL.US' },
  twelvedata_quote: { symbol: 'AAPL' },
  alphavantage_stock_quote: { ticker: 'AAPL' },

  // --- free replacements for the paid gaps
  yahoo_quote: { ticker: 'VOD.LSE' },
  yahoo_history: { ticker: '7203.TSE', range: '1mo', interval: '1d' },
  sec_filings: { ticker: 'AAPL', form: '10-K', limit: 2 },
  sec_financials: { ticker: 'AAPL', metrics: ['revenue'], years: 3 },

  // --- remaining provider leaves
  alphavantage_stock_time_series: { ticker: 'AAPL', outputsize: 'compact' },
  alphavantage_fx_rate: { from_currency: 'EUR', to_currency: 'USD' },
  alphavantage_crypto_rating: { symbol: 'BTC', market: 'USD' },
  alphavantage_commodity: { commodity: 'WTI' },
  polygon_stock_aggregates: {
    ticker: 'AAPL',
    resolution: 'day',
    start_date: '2026-08-01',
    end_date: '2026-09-01',
  },
  polygon_forex_snapshot: { pair: 'EUR/USD' },
  finnhub_sentiment: { ticker: 'AAPL' },
  finnhub_earnings_calendar: { from: '2026-09-01', to: '2026-09-30', symbol: 'AAPL' },
  finnhub_insider_transactions: { ticker: 'AAPL' },
  finnhub_insider_sentiment: { ticker: 'AAPL' },
  finnhub_symbol_search: { query: 'Rheinmetall' },
  fmp_earnings_calendar: { from: '2026-09-01', to: '2026-09-15' },
  fmp_earnings_surprises: { ticker: 'AAPL' },
  twelvedata_time_series: { symbol: 'AAPL', interval: '1day', outputsize: 5 },
  twelvedata_fx_rate: { pair: 'EUR/USD' },
  coingecko_markets: { vs_currency: 'usd', limit: 3 },
  coingecko_global_metrics: {},
  cmc_listings: { limit: 3, convert: 'USD' },
  cmc_global_metrics: { convert: 'USD' },
  btc_supply: {},
  get_commodity: { commodity: 'oil' },
  rentcast_rent_estimate: { address: '5500 Grand Lake Dr, San Antonio, TX 78244', bedrooms: 3, bathrooms: 2 },
  rentcast_value_estimate: { address: '5500 Grand Lake Dr, San Antonio, TX 78244' },
  realtor_properties_for_sale: { city: 'Austin', state_code: 'TX', limit: 3 },

  // --- meta tools and non-provider surfaces that are still safe to call
  read_filings: { query: 'AAPL latest 10-K risk factors' },
  stock_screener: { query: 'US large caps with P/E below 15' },
  x_search: { command: 'search', query: 'NVDA earnings' },
  web_fetch: { url: 'https://example.com', prompt: 'What is this page?' },
  memory_search: { query: 'retirement' },
  memory_get: { path: 'MEMORY.md' },
  portfolio_view: {},

  // --- crypto
  coingecko_simple_price: { ids: 'bitcoin', vs_currency: 'usd' },
  cmc_quotes: { symbol: 'BTC', convert: 'USD' },
  btc_network_stats: {},

  // --- news and search
  get_news: { query: 'Apple' },
  newsapi_everything: { query: 'apple', days_back: 3, page_size: 2, language: 'en' },
  benzinga_news: { tickers: 'AAPL', days_back: 3, limit: 2 },
  benzinga_analyst_ratings: { tickers: 'AAPL', days_back: 120, limit: 3 },
  marketaux_news: { symbols: 'AAPL', days_back: 3, limit: 2 },
  web_search: { query: 'Apple earnings' },
};

/**
 * The free tool to reach for when a paid one is unavailable.
 *
 * A health check that only says "this is behind your plan" leaves the reader
 * to work out what to do about it. Every entry here was verified working, so
 * a PLAN line is a redirection rather than a dead end.
 */
const SUBSTITUTES: Record<string, string> = {
  get_financials: 'sec_financials (US, XBRL from EDGAR) + fmp_income_statement / tiingo_fundamentals',
  get_market_data: 'yahoo_quote (global) + finnhub_quote (US)',
  read_filings: 'sec_filings, then web_fetch the document URL',
  polygon_stock_snapshot: 'finnhub_quote or yahoo_quote',
  polygon_stock_aggregates: 'yahoo_history or tiingo_eod_prices',
  polygon_forex_snapshot: 'get_fx_rates (ECB, keyless)',
  finnhub_sentiment: 'marketaux_news — carries a per-entity sentiment_score',
  fmp_stock_screener: 'screen_universe — free, over your configured universe',
  stock_screener: 'screen_universe',
  eodhd_fundamentals: 'sec_financials (US) or tiingo_fundamentals',
  eodhd_eod_prices: 'yahoo_history',
  rentcast_rent_estimate: 'no free equivalent — real-estate data is peripheral to equity research',
  rentcast_value_estimate: 'no free equivalent',
  realtor_properties_for_sale: 'no free equivalent',
  x_search: 'web_search — X\'s free tier sells no search quota, so this returns 402 credits depleted',
  get_insider_trades: 'finnhub_insider_transactions (same SEC Form 4 data, free tier)',
  get_available_stock_tickers: 'finnhub_symbol_search',
  get_available_crypto_tickers: 'coingecko_markets',
};
/**
 * Tools deliberately outside the sweep, with the reason. Without this an
 * unchecked tool is indistinguishable from an untested one, and the summary
 * quietly under-reports what is actually unknown.
 */
const EXCLUDED: Record<string, string> = {
  investment_report: 'grades the whole universe - minutes of runtime, hundreds of calls',
  run_debate: 'spawns five agents; a health sweep should not cost that',
  spawn_subagent: 'spawns an agent; same reason',
  ask_user_question: 'blocks for interactive input',
  browser: 'drives a real browser; too heavy for a sweep',
  skill: 'dispatcher, not a data source',
  heartbeat: 'writes monitoring state',
  cron: 'creates and mutates scheduled jobs',
  write_file: 'mutates the filesystem',
  edit_file: 'mutates the filesystem',
  read_file: 'needs a path that exists on the caller machine',
  memory_update: 'mutates stored memory',
  portfolio_add: 'mutates the portfolio',
  portfolio_remove: 'mutates the portfolio',
  portfolio_journal: 'mutates the portfolio',
  portfolio_set_risk: 'mutates the portfolio',
  income_confirm: 'records a payment: mutates the ledger and holdings',
  portfolio_import: 'writes the pending import, which would replace one the owner is reviewing',
  thesis_check: 'needs a held position with a real thesis; covered by src/judge tests',
};
/**
 * Provider errors that mean "your plan", not "your code". A rate limit is
 * neither — re-run before believing a single failure, the free tiers here throttle
 * quickly when the whole sweep runs back to back.
 */
const PLAN_LIMIT =
  /insufficient credits|credits depleted|restricted endpoint|payment required|402|403|legacy endpoint|premium|subscription|not subscribed/i;

/** Transient throttling. Free tiers here throttle hard when the whole sweep runs back to back. */
const RATE_LIMIT = /429|too many requests|rate limit|limit reached|daily limit/i;

/**
 * Failures inside the LLM planning step of a meta-tool. The data path may be
 * perfectly healthy; the model was slow, overloaded, or returned an error page.
 * Reporting these as DEAD points the reader at the wrong subsystem.
 */
const LLM_PLANNING = /Failed to plan|Failed to build screening|JSON Parse error|Unrecognized token/i;

type Status = 'ok' | 'plan' | 'broken' | 'skipped' | 'unchecked';

/**
 * A tool that never returns used to hang the whole sweep. Twice this stalled
 * silently on the sixth tool and had to be killed, which means the sweep could
 * not do the one job it exists for. From the agent's side a call that never
 * comes back is a broken tool, so it is reported as one.
 */
// Sits above DEFAULT_LLM_TIMEOUT_MS on purpose. A sweep that is stricter than
// the agent's own budget reports tools DEAD that would have answered in time.
const TOOL_TIMEOUT_MS = 150_000;

function withTimeout<T>(work: Promise<T>, name: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`no response after ${TOOL_TIMEOUT_MS / 1000}s (tool: ${name})`)),
        TOOL_TIMEOUT_MS,
      ).unref?.(),
    ),
  ]);
}

async function check(
  name: string,
  tool: { invoke: (a: unknown) => Promise<unknown> },
  args: Record<string, unknown>,
) {
  try {
    // invoke(), not func(): invoke applies the Zod schema defaults, which is how
    // the agent actually calls a tool. Calling func() directly leaves defaulted
    // fields undefined and manufactures failures that do not exist in practice.
    const out = String(await withTimeout(tool.invoke(args), name));
    const head = out.slice(0, 500);
    // Only an explicit error envelope counts as a failure. Matching plan-limit
    // words anywhere in the payload flags a web search for "403" as broken.
    const envelope = /"error"\s*:|invalid api key|no data returned/i.exec(head);
    if (envelope) {
      const status: Status = PLAN_LIMIT.test(head) ? 'plan' : 'broken';
      return { status, detail: head.slice(0, 120) };
    }
    return { status: 'ok' as Status, detail: head.slice(0, 80).replace(/\s+/g, ' ') };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: (PLAN_LIMIT.test(message) ? 'plan' : 'broken') as Status,
      detail: message.slice(0, 140),
    };
  }
}

async function main(): Promise<void> {
  const registry = getToolRegistry(DEFAULT_MODEL);
  const results: Array<{ name: string; status: Status; detail: string }> = [];

  let index = 0;
  for (const entry of registry) {
    index += 1;
    const position = `${String(index).padStart(3)}/${registry.length}`;
    const args = FIXTURES[entry.name];
    if (!args) {
      const reason = EXCLUDED[entry.name];
      results.push({
        name: entry.name,
        status: reason ? 'skipped' : 'unchecked',
        detail: reason ?? 'NO FIXTURE - this tool is untested',
      });
      if (!reason) console.log(`${position} --   ${entry.name.padEnd(28)} NO FIXTURE - untested`);
      continue;
    }
    const tool = entry.tool as unknown as { invoke: (a: unknown) => Promise<unknown> };
    let r = await check(entry.name, tool, args);
    // One retry before calling anything dead: a single throttled response during
    // a back-to-back sweep is not a broken tool, and a false DEAD is exactly the
    // noise that makes a health check get ignored.
    // Retrying our own timeout only doubles the wall clock: a tool that has not
    // answered in 150s is not going to on the second ask.
    if (r.status === 'broken' && !/no response after/.test(r.detail)) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      r = await check(entry.name, tool, args);
      if (r.status === 'broken' && LLM_PLANNING.test(r.detail)) {
        r = { status: 'plan' as Status, detail: `LLM planning step failed: ${r.detail}` };
      } else if (r.status === 'broken' && RATE_LIMIT.test(r.detail)) {
        r = { status: 'plan' as Status, detail: `rate-limited: ${r.detail}` };
      }
    }
    results.push({ name: entry.name, status: r.status, detail: r.detail });
    const mark = { ok: 'OK  ', plan: 'PLAN', broken: 'DEAD', skipped: 'skip', unchecked: '--  ' }[r.status];
    console.log(`${position} ${mark} ${entry.name.padEnd(28)} ${r.detail}`);
  }

  const by = (s: Status) => results.filter((r) => r.status === s);
  const nlIndent = String.fromCharCode(10) + ' '.repeat(42);
  console.log('\n--- summary');
  console.log(`ok:        ${by('ok').length}`);
  const planned = by('plan');
  console.log(`plan:      ${planned.length}`);
  for (const r of planned) {
    const substitute = SUBSTITUTES[r.name] ?? 'no free equivalent identified';
    console.log(`             ${r.name.padEnd(28)} use instead: ${substitute}`);
  }
  const dead = by('broken');
  console.log(`dead:      ${dead.length}`);
  for (const r of dead) {
    // A dead tool with a known replacement is still a redirection, not a wall.
    const substitute = SUBSTITUTES[r.name];
    console.log(
      `             ${r.name.padEnd(28)} ${r.detail}${substitute ? nlIndent + `use instead: ${substitute}` : ''}`,
    );
  }
  console.log(`skipped:   ${by('skipped').length}  (mutating, interactive or expensive by design)`);
  console.log(`unchecked: ${by('unchecked').length}  ${by('unchecked').map((r) => r.name).join(' ')}`);

  // A plan limit is the account's problem; a dead tool is ours.
  process.exit(by('broken').length > 0 ? 1 : 0);
}

await main();
