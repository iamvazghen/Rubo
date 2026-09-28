/**
 * The slash-command registry.
 *
 * This is the single source of truth: the palette, the autocomplete and the
 * /help panel are all generated from it. The help text used to be a separate
 * hand-maintained string, which had already drifted — seven commands existed
 * that /help never mentioned. A test asserts the two can no longer diverge.
 */
export type CommandCategory = 'Research' | 'Portfolio' | 'Session' | 'Data' | 'Display' | 'Cost';

export interface SlashCommand {
  name: string;
  /** One line, shown in the palette and autocomplete. */
  description: string;
  category: CommandCategory;
  /** Argument shape, when the command takes any. */
  usage?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  // --- Research: the reason the tool exists
  {
    name: 'grade',
    description: 'Score a ticker 0-100 on both horizons with the factor breakdown',
    category: 'Research',
    usage: '/grade AAPL',
  },
  {
    name: 'report',
    description: 'Run the ranked universe review and diff it against the last run',
    category: 'Research',
    usage: '/report [short|long]',
  },
  {
    name: 'watch',
    description: 'Add tickers to the watchlist',
    category: 'Research',
    usage: '/watch AAPL NVDA MSFT',
  },
  { name: 'unwatch', description: 'Remove tickers from the watchlist', category: 'Research', usage: '/unwatch AAPL' },
  { name: 'watchlist', description: 'Show the current watchlist', category: 'Research' },

  // --- Portfolio: holdings, income, rebalancing (answered by code, same on Telegram)
  { name: 'import', description: 'Import holdings from a Trade Republic or IBKR CSV export', category: 'Portfolio', usage: '/import <file.csv> [ibkr|traderepublic] · /import confirm' },
  { name: 'income', description: 'Dividends, distributions and coupons due in the next 90 days', category: 'Portfolio', usage: '/income [refresh]' },
  { name: 'yieldplan', description: 'Your plan for income: reinvest, reserve, withdraw, other asset', category: 'Portfolio', usage: '/yieldplan set reinvest 40 reserve 30 withdraw 20 repurpose 10 VWCE' },
  { name: 'done', description: 'Record a payment as handled according to your plan', category: 'Portfolio', usage: '/done KO:2026-09-15' },
  { name: 'reserve', description: 'Balance of the cash reserve for down markets', category: 'Portfolio' },
  { name: 'tax', description: 'Tax residence, brokers, W-8BEN, church tax, allowance left', category: 'Portfolio', usage: '/tax set church 8' },
  { name: 'targets', description: 'Target weights for rebalancing', category: 'Portfolio', usage: '/targets set stock 50 etf 40 cash 10' },
  { name: 'rebalance', description: 'How far holdings drifted and the trades that fix it', category: 'Portfolio', usage: '/rebalance [cash 1000]' },

  // --- Session
  { name: 'clear', description: 'Clear the conversation and start fresh', category: 'Session' },
  { name: 'history', description: 'Show recent conversation summaries', category: 'Session' },
  { name: 'sessions', description: 'List saved CLI and Telegram sessions you can resume', category: 'Session' },
  { name: 'resume', description: 'Resume a session: /resume telegram:2026-09-28_14-05-12, or the latest', category: 'Session' },
  { name: 'memory', description: 'Show what Rubo remembers about you', category: 'Session' },
  { name: 'rules', description: 'Show your research rules', category: 'Session' },
  { name: 'heartbeat', description: 'Show your heartbeat monitoring checklist', category: 'Session' },

  // --- Data
  { name: 'providers', description: 'Show which data providers are active', category: 'Data' },
  { name: 'cache', description: 'Show tool-cache stats, or clear it', category: 'Data', usage: '/cache [clear]' },
  { name: 'search', description: 'Choose the preferred web search provider', category: 'Data' },

  // --- Display
  { name: 'model', description: 'Switch LLM provider and model', category: 'Display' },
  {
    name: 'thinking',
    description: 'Show or hide reasoning blocks from thinking models',
    category: 'Display',
    usage: '/thinking [on|off]',
  },
  {
    name: 'theme',
    description: 'Switch the color theme (emerald · sapphire · amethyst · obsidian)',
    category: 'Display',
    usage: '/theme [name]',
  },
  { name: 'palette', description: 'Open the fuzzy command palette (also Ctrl+P)', category: 'Display' },
  { name: 'help', description: 'Show every command and keyboard shortcut', category: 'Display' },

  // --- Cost
  { name: 'cost', description: 'Show running session cost, or set a cap', category: 'Cost', usage: '/cost [cap 5]' },
];

/** Order used by the help panel. */
export const CATEGORY_ORDER: CommandCategory[] = [
  'Research',
  'Portfolio',
  'Session',
  'Data',
  'Display',
  'Cost',
];

export interface KeyBinding {
  keys: string;
  description: string;
}

export const KEY_BINDINGS: KeyBinding[] = [
  { keys: 'enter', description: 'Send the current message' },
  { keys: 'esc', description: 'Interrupt the running query, or clear the input' },
  { keys: 'ctrl+p', description: 'Command palette — fuzzy search commands, sessions and tickers' },
  { keys: 'ctrl+c', description: 'Exit Rubo' },
  { keys: '↑ / ↓', description: 'Walk back through input history' },
];

/**
 * Filter commands matching the current input.
 * Input should start with "/". Bare "/" returns all commands.
 */
export function matchCommands(input: string): SlashCommand[] {
  const query = input.slice(1).toLowerCase();
  if (query === '') return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((cmd) => cmd.name.startsWith(query));
}

export function commandsByCategory(category: CommandCategory): SlashCommand[] {
  return SLASH_COMMANDS.filter((c) => c.category === category);
}
