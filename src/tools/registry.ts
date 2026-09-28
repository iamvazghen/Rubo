import { StructuredToolInterface } from '@langchain/core/tools';
import {
  createGetFinancials,
  createGetMarketData,
  createReadFilings,
  createScreenStocks,
  getFxRates,
  FX_RATES_DESCRIPTION,
  getEconomicIndicators,
  ECONOMIC_INDICATORS_DESCRIPTION,
  getCatalystCalendar,
  GET_CATALYST_CALENDAR_DESCRIPTION,
  getGlobalStock,
  GET_GLOBAL_STOCK_DESCRIPTION,
  getCommodity,
  GET_COMMODITY_DESCRIPTION,
  getFredSeries,
  getFredSeriesMulti,
  fredSearch,
  FRED_DESCRIPTION,
  FRED_SEARCH_DESCRIPTION,
} from './finance/index.js';
import { exaSearch, perplexitySearch, tavilySearch, langSearch, WEB_SEARCH_DESCRIPTION, xSearchTool, X_SEARCH_DESCRIPTION } from './search/index.js';
import { createWebSearchTool, type WebSearchProvider } from './search/web-search.js';
import { getSetting } from '../utils/config.js';
import type { SearchProviderId } from '../utils/env.js';
import { skillTool, SKILL_TOOL_DESCRIPTION } from './skill.js';
import { createWebFetch, WEB_FETCH_DESCRIPTION } from './fetch/web-fetch.js';
import { browserTool, BROWSER_DESCRIPTION } from './browser/browser.js';
import { readFileTool, READ_FILE_DESCRIPTION } from './filesystem/read-file.js';
import { writeFileTool, WRITE_FILE_DESCRIPTION } from './filesystem/write-file.js';
import { editFileTool, EDIT_FILE_DESCRIPTION } from './filesystem/edit-file.js';
import { GET_FINANCIALS_DESCRIPTION } from './finance/get-financials.js';
import { GET_MARKET_DATA_DESCRIPTION } from './finance/get-market-data.js';
import { READ_FILINGS_DESCRIPTION } from './finance/read-filings.js';
import { SCREEN_STOCKS_DESCRIPTION } from './finance/screen-stocks.js';
import { heartbeatTool, HEARTBEAT_TOOL_DESCRIPTION } from './heartbeat/heartbeat-tool.js';
import { cronTool, CRON_TOOL_DESCRIPTION } from './cron/cron-tool.js';
import { memoryGetTool, MEMORY_GET_DESCRIPTION, memorySearchTool, MEMORY_SEARCH_DESCRIPTION, memoryUpdateTool, MEMORY_UPDATE_DESCRIPTION } from './memory/index.js';
import { discoverSkills } from '../skills/index.js';
import { createSpawnSubagent, SPAWN_SUBAGENT_DESCRIPTION } from './subagent/spawn-subagent.js';
import { createRunDebate, RUN_DEBATE_DESCRIPTION } from './subagent/run-debate.js';
import { createAskUserQuestion, ASK_USER_QUESTION_DESCRIPTION } from './ask-user-question/ask-user-question.js';
import { getAllProviderLeaves } from './finance/providers/index.js';
import { getAllNewsLeaves, getNewsRouterTool } from './news/index.js';
import { portfolioView, portfolioAdd, portfolioRemove, portfolioJournal, portfolioSetRisk } from './portfolio/index.js';
import { incomeCalendar, yieldPlanTool, taxProfileTool, incomeConfirm, rebalanceProposal, rebalanceTargets, portfolioImport } from './portfolio/finance-tools.js';
import { dividendSafety, thesisCheck, newsMateriality } from '../judge/tools.js';
import { jevAvailable } from '../judge/jev.js';
import {
  gradeTickerTool,
  GRADE_TICKER_DESCRIPTION,
  investmentReportTool,
  INVESTMENT_REPORT_DESCRIPTION,
  scoreHistoryTool,
  SCORE_HISTORY_DESCRIPTION,
  screenUniverseTool,
  SCREEN_UNIVERSE_DESCRIPTION,
} from './scoring.js';
import { checkApiKeyExists } from '../utils/env.js';

/** A key set to a `your-...` placeholder is not a configured provider. */
const hasApiKey = (name: string): boolean => checkApiKeyExists(name);

/**
 * A registered tool with its rich description for system prompt injection.
 */
export interface RegisteredTool {
  /** Tool name (must match the tool's name property) */
  name: string;
  /** The actual tool instance */
  tool: StructuredToolInterface;
  /** Rich description for system prompt (includes when to use, when not to use, etc.) */
  description: string;
  /** 1-2 sentence description for token-optimized system prompts. */
  compactDescription: string;
  /** Whether this tool can safely execute concurrently with other concurrent-safe tools. */
  concurrencySafe: boolean;
}

/**
 * Get all registered tools with their descriptions.
 * Conditionally includes tools based on environment configuration.
 *
 * @param model - The model name (needed for tools that require model-specific configuration)
 * @returns Array of registered tools
 */
export function getToolRegistry(model: string): RegisteredTool[] {
  const tools: RegisteredTool[] = [
    {
      name: 'grade_ticker',
      tool: gradeTickerTool,
      description: GRADE_TICKER_DESCRIPTION,
      compactDescription: 'Grade a stock 0-100 on a 1-3y and a 20y+ horizon, with the weighted factor breakdown. Deterministic. The opening move on any single-ticker judgement.',
      concurrencySafe: true,
    },
    {
      name: 'investment_report',
      tool: investmentReportTool,
      description: INVESTMENT_REPORT_DESCRIPTION,
      compactDescription: 'Grade and rank the whole universe, diff against the last run, review holdings for decay. The periodic review.',
      concurrencySafe: false,
    },
    {
      name: 'screen_universe',
      tool: screenUniverseTool,
      description: SCREEN_UNIVERSE_DESCRIPTION,
      compactDescription: 'Screen the universe by numeric criteria (P/E, ROE, margins, growth) using free cached data. Replaces the paid screeners.',
      concurrencySafe: false,
    },
    {
      name: 'score_history',
      tool: scoreHistoryTool,
      description: SCORE_HISTORY_DESCRIPTION,
      compactDescription: 'Read the score ledger: a ticker grade history, the calibration check, or the universe list.',
      concurrencySafe: true,
    },
    {
      name: 'get_financials',
      tool: createGetFinancials(model),
      description: GET_FINANCIALS_DESCRIPTION,
      compactDescription: 'Financial statements and metrics. Handles multi-company/multi-metric queries in one call.',
      concurrencySafe: true,
    },
    {
      name: 'get_market_data',
      tool: createGetMarketData(model),
      description: GET_MARKET_DATA_DESCRIPTION,
      compactDescription: 'Stock/crypto prices, company news, and insider trades. Handles multi-asset queries in one call.',
      concurrencySafe: true,
    },
    {
      name: 'read_filings',
      tool: createReadFilings(model),
      description: READ_FILINGS_DESCRIPTION,
      compactDescription: 'SEC filings (10-K, 10-Q, 8-K). Extracts and summarizes specific filing sections.',
      concurrencySafe: true,
    },
    {
      name: 'stock_screener',
      tool: createScreenStocks(model),
      description: SCREEN_STOCKS_DESCRIPTION,
      compactDescription: 'Screen stocks by financial criteria (P/E, growth, margins, etc.).',
      concurrencySafe: true,
    },
    {
      name: 'get_fx_rates',
      tool: getFxRates,
      description: FX_RATES_DESCRIPTION,
      compactDescription: 'Foreign-exchange (currency) rates: latest, historical, or a time series (ECB/Frankfurter, no key).',
      concurrencySafe: true,
    },
    {
      name: 'get_economic_indicators',
      tool: getEconomicIndicators,
      description: ECONOMIC_INDICATORS_DESCRIPTION,
      compactDescription: 'Macroeconomic indicators by country (GDP, inflation, unemployment, rates) from World Bank, no key.',
      concurrencySafe: true,
    },
    {
      name: 'spawn_subagent',
      tool: createSpawnSubagent(model),
      description: SPAWN_SUBAGENT_DESCRIPTION,
      compactDescription: 'Delegate a focused sub-task to an isolated subagent. Emit multiple calls in one turn to run independent sub-tasks in parallel.',
      concurrencySafe: true,
    },
    {
      name: 'run_debate',
      tool: createRunDebate(model),
      description: RUN_DEBATE_DESCRIPTION,
      compactDescription: 'Run a 4-specialist investment debate + judge synthesis (high cost, high conviction trades only).',
      concurrencySafe: false,
    },
    {
      name: 'ask_user_question',
      tool: createAskUserQuestion(),
      description: ASK_USER_QUESTION_DESCRIPTION,
      compactDescription: 'Ask the user 1-4 multiple-choice questions mid-turn and wait for their answers. CLI only.',
      concurrencySafe: false,
    },
    {
      name: 'web_fetch',
      tool: createWebFetch(model),
      description: WEB_FETCH_DESCRIPTION,
      compactDescription: 'Fetch a URL and answer a prompt about its content (HTML→markdown, fast-model summarized).',
      concurrencySafe: true,
    },
    {
      name: 'browser',
      tool: browserTool,
      description: BROWSER_DESCRIPTION,
      compactDescription: 'JavaScript-rendered pages and interactive navigation. Actions: navigate, snapshot, act, read, close.',
      concurrencySafe: true,
    },
    {
      name: 'read_file',
      tool: readFileTool,
      description: READ_FILE_DESCRIPTION,
      compactDescription: 'Read a local file by path. Returns file content as text.',
      concurrencySafe: true,
    },
    {
      name: 'write_file',
      tool: writeFileTool,
      description: WRITE_FILE_DESCRIPTION,
      compactDescription: 'Create or overwrite a file. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'edit_file',
      tool: editFileTool,
      description: EDIT_FILE_DESCRIPTION,
      compactDescription: 'Edit a file by replacing text. Requires user approval.',
      concurrencySafe: false,
    },
    {
      name: 'heartbeat',
      tool: heartbeatTool,
      description: HEARTBEAT_TOOL_DESCRIPTION,
      compactDescription: 'View or update the periodic heartbeat checklist (.rubo/HEARTBEAT.md).',
      concurrencySafe: true,
    },
    {
      name: 'cron',
      tool: cronTool,
      description: CRON_TOOL_DESCRIPTION,
      compactDescription: 'Manage scheduled cron jobs (create, list, update, delete).',
      concurrencySafe: true,
    },
    {
      name: 'memory_search',
      tool: memorySearchTool,
      description: MEMORY_SEARCH_DESCRIPTION,
      compactDescription: 'Search persistent memory and past conversations for stored facts and preferences.',
      concurrencySafe: true,
    },
    {
      name: 'memory_get',
      tool: memoryGetTool,
      description: MEMORY_GET_DESCRIPTION,
      compactDescription: 'Read specific memory file sections by line range.',
      concurrencySafe: true,
    },
    {
      name: 'memory_update',
      tool: memoryUpdateTool,
      description: MEMORY_UPDATE_DESCRIPTION,
      compactDescription: 'Add, edit, or delete persistent memory entries.',
      concurrencySafe: false,
    },
  ];

  // Build web_search as a fallback chain over whichever providers have keys configured.
  // The user's preferred provider (set via /search) is tried first; the others act as fallbacks.
  const allWebSearchProviders: WebSearchProvider[] = [];
  if (hasApiKey('EXASEARCH_API_KEY')) {
    allWebSearchProviders.push({ id: 'exa', name: 'Exa', tool: exaSearch });
  }
  if (hasApiKey('PERPLEXITY_API_KEY')) {
    allWebSearchProviders.push({ id: 'perplexity', name: 'Perplexity', tool: perplexitySearch });
  }
  if (hasApiKey('TAVILY_API_KEY')) {
    allWebSearchProviders.push({ id: 'tavily', name: 'Tavily', tool: tavilySearch });
  }
  if (hasApiKey('LANGSEARCH_API_KEY')) {
    allWebSearchProviders.push({ id: 'langsearch', name: 'LangSearch', tool: langSearch });
  }

  if (allWebSearchProviders.length > 0) {
    const preferred = getSetting<SearchProviderId | undefined>('webSearchPreferredProvider', undefined);
    const orderedProviders = preferred
      ? [
          ...allWebSearchProviders.filter((p) => p.id === preferred),
          ...allWebSearchProviders.filter((p) => p.id !== preferred),
        ]
      : allWebSearchProviders;

    tools.push({
      name: 'web_search',
      tool: createWebSearchTool(orderedProviders),
      description: WEB_SEARCH_DESCRIPTION,
      compactDescription: 'Search the web for current information. Returns titles, URLs, and snippets.',
      concurrencySafe: true,
    });
  }

  if (hasApiKey('X_BEARER_TOKEN')) {
    tools.push({
      name: 'x_search',
      tool: xSearchTool,
      description: X_SEARCH_DESCRIPTION,
      compactDescription: 'Search X/Twitter for tweets, profiles, and threads.',
      concurrencySafe: true,
    });
  }

  const availableSkills = discoverSkills();
  if (availableSkills.length > 0) {
    tools.push({
      name: 'skill',
      tool: skillTool,
      description: SKILL_TOOL_DESCRIPTION,
      compactDescription: 'Invoke a specialized skill workflow (e.g., DCF valuation).',
      concurrencySafe: false,
    });
  }

  // Roadmap data providers — only registered when the matching env key is set.
  // Ponytail: leaf tools, no extra meta-tool wrapper. Each provider's
  // `getLeaves()` already returned null for missing keys.
  for (const leaf of getAllProviderLeaves()) {
    tools.push({
      name: leaf.name,
      tool: leaf,
      description: leaf.description,
      compactDescription: leaf.description.split('.')[0],
      concurrencySafe: true,
    });
  }

  for (const leaf of getAllNewsLeaves()) {
    tools.push({
      name: leaf.name,
      tool: leaf,
      description: leaf.description,
      compactDescription: leaf.description.split('.')[0],
      concurrencySafe: true,
    });
  }

  // News router — agent should prefer this over picking individual news tools.
  const newsRouter = getNewsRouterTool();
  if (newsRouter) {
    tools.push({
      name: 'get_news',
      tool: newsRouter,
      description: newsRouter.description,
      compactDescription: 'Meta-tool that picks the best news source for the query (Marketaux/Benzinga/NewsAPI).',
      concurrencySafe: true,
    });
  }

  // Catalyst calendar — only when at least one earnings source is configured.
  if (hasApiKey('FMP_API_KEY') || hasApiKey('FINNHUB_API_KEY')) {
    tools.push({
      name: 'get_catalyst_calendar',
      tool: getCatalystCalendar,
      description: GET_CATALYST_CALENDAR_DESCRIPTION,
      compactDescription: 'Upcoming earnings + catalyst calendar (FMP > Finnhub fallback). Use this whenever you cite a price target.',
      concurrencySafe: true,
    });
  }

  // Multi-series FRED fetch — single-call macro dashboard for "rates + yields + inflation".
  if (hasApiKey('FRED_API_KEY')) {
    tools.push({
      name: 'get_fred_series_multi',
      tool: getFredSeriesMulti,
      description: FRED_DESCRIPTION + ' (2-9 series in one call; use for macro dashboards).',
      compactDescription: 'Multi-series FRED macro fetch (rates + yields + inflation in one call).',
      concurrencySafe: true,
    });
    // Without search the agent can only fetch series IDs it already knows,
    // which is a couple of dozen out of ~841,000.
    tools.push({
      name: 'fred_search',
      tool: fredSearch,
      description: FRED_SEARCH_DESCRIPTION,
      compactDescription: 'Find FRED series IDs by keyword before fetching them.',
      concurrencySafe: true,
    });
  }

  // Global stock — non-US tickers via EODHD (TICKER.EXCHANGE notation).
  if (hasApiKey('EODHD_API_KEY')) {
    tools.push({
      name: 'get_global_stock',
      tool: getGlobalStock,
      description: GET_GLOBAL_STOCK_DESCRIPTION,
      compactDescription: 'Region-aware global stock quote for non-US tickers (EODHD, normalizes TICKER.EXCHANGE notation + local currency).',
      concurrencySafe: true,
    });
  }

  // Commodities — Alpha Vantage preferred, FRED fallback for select series.
  if (hasApiKey('ALPHA_VANTAGE_API_KEY') || hasApiKey('FRED_API_KEY')) {
    tools.push({
      name: 'get_commodity',
      tool: getCommodity,
      description: GET_COMMODITY_DESCRIPTION,
      compactDescription: 'Latest commodity price (WTI, BRENT, NatGas, copper, wheat, corn, sugar, coffee, etc.) from Alpha Vantage with FRED fallback.',
      concurrencySafe: true,
    });
  }

  // Portfolio tools — always available (no env key required; persists locally).
  tools.push(
    {
      name: 'portfolio_view',
      tool: portfolioView,
      description: 'View the user portfolio: open positions, recent closes, journal entries, risk profile. ALWAYS call before personalized advice.',
      compactDescription: 'Read user portfolio (positions, closed history, journal, risk profile).',
      concurrencySafe: true,
    },
    {
      name: 'portfolio_add',
      tool: portfolioAdd,
      description: 'Add a new open position. Confirm with the user before calling.',
      compactDescription: 'Add an open position to the portfolio.',
      concurrencySafe: false,
    },
    {
      name: 'portfolio_remove',
      tool: portfolioRemove,
      description: 'Close an existing open position. Records exit price + realized P&L + lesson.',
      compactDescription: 'Close an open position; record realized P&L.',
      concurrencySafe: false,
    },
    {
      name: 'portfolio_journal',
      tool: portfolioJournal,
      description: 'Append a free-form note to the portfolio journal (observations, trade ideas, lessons).',
      compactDescription: 'Append a portfolio journal entry.',
      concurrencySafe: false,
    },
    {
      name: 'portfolio_set_risk',
      tool: portfolioSetRisk,
      description: 'Set the user risk profile (total capital USD, max % per trade, max drawdown).',
      compactDescription: 'Set the user risk profile (capital, risk budget, max drawdown).',
      concurrencySafe: false,
    },
    // Income, import and rebalancing: same code as the /commands.
    { name: 'income_calendar', tool: incomeCalendar, description: 'Dividends, distributions and coupons due in the next 90 days, gross and net in USD, with ids.', compactDescription: 'Upcoming income (dividends/coupons), gross and net.', concurrencySafe: true },
    { name: 'yield_plan', tool: yieldPlanTool, description: "Show or change the owner's income plan (reinvest/reserve/withdraw/repurpose). Confirm before changing.", compactDescription: 'Show or set the income plan.', concurrencySafe: false },
    { name: 'tax_profile', tool: taxProfileTool, description: 'Tax residence, per-account W-8BEN and withholding, allowance left. Confirm before changing.', compactDescription: 'Show or set the tax profile.', concurrencySafe: false },
    { name: 'income_confirm', tool: incomeConfirm, description: 'Record a payment as handled per plan. Only when the owner says it is done.', compactDescription: 'Mark an income payment as handled.', concurrencySafe: false },
    { name: 'rebalance_proposal', tool: rebalanceProposal, description: 'Drift from target weights and tax-aware trades to fix it. Suggestions only.', compactDescription: 'Rebalancing drift and suggested trades.', concurrencySafe: true },
    { name: 'rebalance_targets', tool: rebalanceTargets, description: 'Show or set rebalancing target weights. Confirm before changing.', compactDescription: 'Show or set target weights.', concurrencySafe: false },
    { name: 'portfolio_import', tool: portfolioImport, description: 'Preview a broker CSV import, or apply it after the owner confirmed.', compactDescription: 'Import holdings from a broker CSV.', concurrencySafe: false },
  );

  // Jev judgements: only with a TypeSafe key.
  if (jevAvailable()) {
    tools.push(
      { name: 'dividend_safety', tool: dividendSafety, description: 'Jev probability of a dividend cut within 12 months. Present as a probability.', compactDescription: 'Dividend cut probability (Jev).', concurrencySafe: true },
      { name: 'thesis_check', tool: thesisCheck, description: "Jev: is the owner's thesis for a holding still intact given new evidence?", compactDescription: 'Thesis still intact? (Jev).', concurrencySafe: true },
      { name: 'news_materiality', tool: newsMateriality, description: 'Jev: is a news item material to a held position, and which direction?', compactDescription: 'Is this news material? (Jev).', concurrencySafe: true },
    );
  }

  return tools;
}

/**
 * Build a name → concurrencySafe map for the tool executor.
 */
export function getToolConcurrencyMap(model: string): Map<string, boolean> {
  return new Map(getToolRegistry(model).map(t => [t.name, t.concurrencySafe]));
}

/**
 * Get just the tool instances for binding to the LLM.
 *
 * @param model - The model name
 * @returns Array of tool instances
 */
export function getTools(model: string): StructuredToolInterface[] {
  return getToolRegistry(model).map((t) => t.tool);
}

/**
 * Build the tool descriptions section for the system prompt.
 * Formats each tool's rich description with a header.
 *
 * @param model - The model name
 * @returns Formatted string with all tool descriptions
 */
/**
 * Build compact tool descriptions for token-optimized system prompts.
 * Uses 1-2 sentence descriptions instead of full multi-paragraph ones.
 * The LLM already has full tool schemas via bindTools().
 */
export function buildCompactToolDescriptions(model: string): string {
  return getToolRegistry(model)
    .map((t) => `- **${t.name}**: ${t.compactDescription}`)
    .join('\n');
}
