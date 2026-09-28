/**
 * End-to-end behavioral test driver.
 *
 * Runs a hand-picked set of representative queries through the full Agent
 * stack (registry → tools → LLM → memory → sessions) and logs every tool
 * call, the final answer, tokens, and timing.
 *
 * Usage:
 *   bun run src/evals/behavioral.ts
 */
import 'dotenv/config';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point state writes at a scratch directory before anything resolves a path.
 *
 * These are full agent runs, so a case like "I bought 100 shares of KO" does
 * what it says: the first run of it added a real position to the real
 * portfolio, which then had to be picked out of the JSON by hand. A behavioral
 * suite that mutates the state it is testing against is not repeatable, and
 * worse, it silently corrupts the thing the operator actually relies on.
 *
 * Memory is copied in rather than left empty, because what the agent recalls
 * changes which tools it reaches for - that is part of what is under test.
 */
const SCRATCH_HOME = mkdtempSync(join(tmpdir(), 'rubo-behavioral-'));
const REAL_HOME = process.env.RUBO_HOME?.trim() || (existsSync('.rubo') ? '.rubo' : '');
mkdirSync(join(SCRATCH_HOME, 'memory'), { recursive: true });
if (REAL_HOME) {
  for (const f of ['MEMORY.md']) {
    const src = join(REAL_HOME, 'memory', f);
    if (existsSync(src)) copyFileSync(src, join(SCRATCH_HOME, 'memory', f));
  }
}
process.env.RUBO_HOME = SCRATCH_HOME;

// Dynamic, and deliberately so: `import` statements are hoisted and run before
// any top-level code, so a static import here would load the agent - and every
// module that captures a state directory - before the assignment above ever
// executed. That is not theoretical: it is how this suite twice wrote a real
// position into the real portfolio while believing it was pointed at scratch.
const { Agent } = await import('../agent/agent.js');
type AgentEvent = import('../agent/types.js').AgentEvent;
const { InMemoryChatHistory } = await import('../utils/in-memory-chat-history.js');
const { resolveProvider } = await import('../providers.js');
const { getActiveProviderNames, getAllProviderNames } = await import(
  '../tools/finance/providers/index.js'
);
const { getActiveNewsProviderNames, getAllNewsProviderNames } = await import(
  '../tools/news/index.js'
);
const { discoverSkills } = await import('../skills/registry.js');

interface TestCase {
  label: string;
  query: string;
  /** Tools we expect this query to involve (rough — for matching, not assertion). */
  expectAnyOf?: string[];
}

const DEFAULT_MODEL = 'minimax:MiniMax-M2.5';

const TEST_CASES: TestCase[] = [
  // 1. Simple US equity snapshot
  { label: 'AAPL price snapshot', query: "What's the current price and day's change for Apple?", expectAnyOf: ['polygon_stock_snapshot', 'finnhub_quote', 'get_stock_price', 'twelvedata_quote', 'alphavantage_stock_quote', 'yahoo_quote'] },
  // 2. Financial ratios — should prefer FMP per the router preference. The agent
  // may either call the meta-tool (get_financials / get_key_ratios) which
  // wraps the leaves, or call the leaves directly (fmp_ratios). Both are
  // valid; the meta-tool is the preferred path.
  { label: 'NVDA valuation metrics', query: "Show me NVDA's current P/E, market cap, and revenue growth.", expectAnyOf: ['fmp_ratios', 'get_key_ratios', 'get_financials'] },
  // 3. Multi-company comparison (router should fan out)
  { label: 'Big Tech revenue comparison', query: 'Compare 2024 annual revenue for AAPL, MSFT, GOOGL, AMZN side by side.', expectAnyOf: ['get_financials', 'fmp_income_statement', 'get_income_statements'] },
  // 4. News search — should hit news_router if active
  { label: 'Tesla news', query: "What's in the news for Tesla today?", expectAnyOf: ['get_news', 'marketaux_news', 'benzinga_news', 'newsapi_everything', 'get_company_news'] },
  // 5. US macro
  { label: 'US Fed + Treasury yields', query: 'What is the current Fed funds rate and the 10-year Treasury yield?', expectAnyOf: ['get_fred_series'] },
  // 6. Global non-US ticker (EODHD path)
  // yahoo_quote is the right answer here now: keyless, and it returned
  // JPY 3,096 tagged Tokyo Stock Exchange. EODHD would have spent one of
  // that provider's 20 daily calls for the same number.
  { label: 'Toyota global price', query: 'Show me Toyota (7203.TSE) latest price in JPY.', expectAnyOf: ['get_global_stock', 'eodhd_eod_prices', 'yahoo_quote'] },
  // 7. Crypto
  { label: 'BTC + ETH price', query: 'What is BTC at in USD right now? Same for ETH.', expectAnyOf: ['coingecko_simple_price', 'cmc_quotes', 'alphavantage_crypto_rating', 'get_crypto_price_snapshot', 'get_market_data'] },
  // 8. High-conviction trade — should auto-fire run_debate per Phase C behavior
  { label: 'High-conviction trade (auto-debate)', query: "Should I buy NVDA here for a 12-month hold? I have $500k and a 1% risk budget.", expectAnyOf: ['run_debate', 'get_financials', 'get_market_data', 'devils-advocate', 'macro-overlay'] },
  // 9. The headline feature. Grading had no behavioral coverage at all, which
  // means nothing checked that the agent reaches for it when asked the exact
  // question it was built to answer.
  { label: 'Grade a ticker', query: 'Rate NVDA as an investment from 0 to 100, short term and long term.', expectAnyOf: ['grade_ticker'] },
  // 10. The recurring review the cron job exists to run.
  { label: 'Best picks review', query: 'What are your best investment picks right now for a long-term hold?', expectAnyOf: ['investment_report', 'grade_ticker'] },
  // 11. Screening by the numbers — must not fall back to a paid screener.
  { label: 'Numeric screen', query: 'Find me companies with return on equity above 20% and operating margin above 25%.', expectAnyOf: ['screen_universe', 'fmp_stock_screener', 'stock_screener'] },
  // 12. Non-US macro. Before fred_search this was unanswerable: the agent could
  // only fetch nine hard-coded US series.
  { label: 'German bond yield', query: 'What is the German 10-year government bond yield doing this year?', expectAnyOf: ['fred_search', 'get_fred_series', 'get_fred_series_multi', 'get_economic_indicators'] },
  // 13. Insider activity — dead until Finnhub was wired in.
  { label: 'Insider activity', query: 'Have Apple insiders been buying or selling recently?', expectAnyOf: ['finnhub_insider_transactions', 'finnhub_insider_sentiment', 'get_insider_trades'] },
  // 14. A company named, not tickered. Resolution was dead until symbol search.
  { label: 'Name to ticker', query: 'Give me a quick read on Rheinmetall as an investment.', expectAnyOf: ['finnhub_symbol_search', 'grade_ticker', 'yahoo_quote', 'web_search'] },
  // 15. Analyst actions rather than a single consensus number.
  { label: 'Analyst ratings', query: 'What have analysts been saying about Apple over the last few months? Any upgrades or downgrades?', expectAnyOf: ['benzinga_analyst_ratings', 'finnhub_recommendation', 'fmp_price_target', 'get_news'] },
  // 16. Portfolio write path. The agent has to recognise a stated trade as an
  // instruction to record it, not as a question to answer.
  { label: 'Record a position', query: 'I bought 100 shares of KO at $70 today. Add it to my portfolio - long-term income position, medium conviction.', expectAnyOf: ['portfolio_add'] },
];

interface TestOutcome {
  label: string;
  query: string;
  answer: string;
  toolCalls: string[];
  toolsExpected: string[];
  toolsExpectedMatched: boolean;
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  errored: boolean;
  error?: string;
}

function indent(text: string, prefix = '  │ '): string {
  return text.split('\n').map((l) => (l ? prefix + l : l)).join('\n');
}

async function runOne(test: TestCase): Promise<TestOutcome> {
  // Isolate this test from prior tests' cache state. The tool cache is
  // process-global by design (subagent cross-call reuse) but means tests
  // in the same bun process can leak state. Clear at the start of each
  // test for reproducibility.
  const { clearToolCache } = await import('../utils/tool-cache.js');
  clearToolCache();

  const history = new InMemoryChatHistory(DEFAULT_MODEL);
  const t0 = Date.now();
  const toolCalls: string[] = [];
  let iterations = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let answer = '';
  let errored = false;
  let error: string | undefined;

  try {
    const agent = await Agent.create({ model: DEFAULT_MODEL, maxIterations: 12, channel: 'cli' });
    for await (const ev of agent.run(test.query, history)) {
      const e = ev as AgentEvent;
      switch (e.type) {
        case 'tool_start':
          toolCalls.push(e.tool);
          break;
        case 'done':
          iterations = (e as { iterations: number }).iterations;
          const u = (e as { tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number } }).tokenUsage;
          if (u) {
            inputTokens = u.inputTokens;
            outputTokens = u.outputTokens;
            totalTokens = u.totalTokens;
          }
          answer = (e as { answer: string }).answer;
          break;
      }
    }
  } catch (err) {
    errored = true;
    error = err instanceof Error ? err.message : String(err);
  }

  return {
    label: test.label,
    query: test.query,
    answer,
    toolCalls,
    toolsExpected: test.expectAnyOf ?? [],
    toolsExpectedMatched: test.expectAnyOf
      ? toolCalls.some((t) => test.expectAnyOf!.includes(t))
      : true,
    iterations,
    inputTokens,
    outputTokens,
    totalTokens,
    durationMs: Date.now() - t0,
    errored,
    error,
  };
}

async function staticFacts(): Promise<void> {
  const activeFinance = getActiveProviderNames();
  const allFinance = getAllProviderNames();
  const activeNews = getActiveNewsProviderNames();
  const allNews = getAllNewsProviderNames();
  const skills = discoverSkills();

  console.log('\n' + '═'.repeat(80));
  console.log('  STATIC FACTS — verified before live run');
  console.log('═'.repeat(80));
  console.log(`Provider: model=${DEFAULT_MODEL}, resolved=${resolveProvider(DEFAULT_MODEL).displayName}`);
  console.log(`Active finance providers (${activeFinance.length}/${allFinance.length}):`);
  for (const n of activeFinance) console.log(`  • ${n}`);
  console.log(`Missing finance providers (${allFinance.length - activeFinance.length}):`);
  for (const n of allFinance.filter((x) => !activeFinance.includes(x))) console.log(`  • ${n}`);
  console.log(`Active news providers (${activeNews.length}/${allNews.length}):`);
  for (const n of activeNews) console.log(`  • ${n}`);
  console.log(`Skills discovered (${skills.length}): ${skills.map((s) => s.name).join(', ')}`);

  // Cross-check the router prompt itself includes the active providers.
  // (Internal helper, not exported — skipped here. Verified manually in Part 4 audit.)
  void activeFinance;
}

async function main(): Promise<void> {
  console.log('Rubo — end-to-end behavioral test');
  console.log('═'.repeat(80));
  await staticFacts();

  console.log('\n' + '═'.repeat(80));
  console.log('  LIVE BEHAVIORAL TESTS');
  console.log('═'.repeat(80));

  const outcomes: TestOutcome[] = [];
  for (const test of TEST_CASES) {
    process.stdout.write(`\n[${test.label}] running: ${test.query}\n`);
    const result = await runOne(test);
    outcomes.push(result);
    if (result.errored) {
      console.log(`  ✗ errored: ${result.error}`);
      continue;
    }
    console.log(`  ✓ completed in ${result.durationMs}ms · ${result.iterations} iter · ${result.totalTokens} tokens`);
    console.log(`  Tool calls (${result.toolCalls.length}):`);
    for (const t of result.toolCalls) console.log(`    - ${t}`);
    if (result.toolsExpected.length > 0) {
      console.log(`  Expected match: ${result.toolsExpectedMatched ? 'YES' : 'NO'}`);
      if (!result.toolsExpectedMatched) {
        console.log(`    Expected one of: ${result.toolsExpected.join(', ')}`);
      }
    }
    const preview = result.answer.length > 500 ? result.answer.slice(0, 500) + '…[truncated]' : result.answer;
    console.log(indent('\n  Answer:\n' + (preview || '(empty)')));
    console.log('  ' + '─'.repeat(76));
  }

  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80));
  const total = outcomes.length;
  const ok = outcomes.filter((o) => !o.errored).length;
  const matched = outcomes.filter((o) => o.toolsExpectedMatched).length;
  const totalTokensUsed = outcomes.reduce((s, o) => s + o.totalTokens, 0);
  const totalDuration = outcomes.reduce((s, o) => s + o.durationMs, 0);
  console.log(`Tests run: ${total}`);
  console.log(`Completed: ${ok}/${total}`);
  console.log(`Expected-tool match: ${matched}/${total}`);
  console.log(`Total tokens: ${totalTokensUsed.toLocaleString()}`);
  console.log(`Total wall time: ${(totalDuration / 1000).toFixed(1)}s`);

  // Cache is cleared at the start of every test, so by the end it's empty.
  // Report the final cache state for transparency.
  const { getToolCacheStats } = await import('../utils/tool-cache.js');
  const stats = getToolCacheStats();
  console.log(`Tool cache: ${stats.size} / ${stats.maxEntries} entries (${stats.totalHits} hits across the run)`);
}

main()
  .then(() => {
    // The suite prints its summary and then hangs: something in the agent stack
    // (sqlite handles, a keep-alive socket) holds the loop open, so the run only
    // ended when the outer timeout killed it 33 minutes after the work finished.
    // Nothing is left to await once the summary is out.
    process.exit(0);
  })
  .catch((err) => {
    console.error('Behavioral test driver error:', err);
    process.exit(1);
  });