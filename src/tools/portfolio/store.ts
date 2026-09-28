/**
 * Portfolio store. Tracks the user's holdings, price targets, conviction
 * levels, and trade journal. Persisted as JSON at `.rubo/portfolio.json`
 * so the agent can read it as a single tool call (not a series of file reads).
 *
 * The portfolio is intentionally *separate* from the long-term memory file
 * (MEMORY.md) because:
 *   1. It's structured data, not prose — JSON is the right format
 *   2. It changes frequently — every trade — and we don't want every trade
 *      to dirty the memory indexer
 *   3. The agent should always have a fresh, queryable view of positions
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getRuboDir } from '../../utils/paths.js';

const PORTFOLIO_FILENAME = 'portfolio.json';

export type Conviction = 'low' | 'med' | 'high';

export interface Position {
  /** Ticker symbol. For non-US, use TICKER.EXCHANGE (e.g., "VOD.LSE"). */
  ticker: string;
  /** Shares held (negative for short). */
  shares: number;
  /** Average cost per share (in local currency; agent must normalize). */
  avg_cost: number;
  /** Local currency (e.g., "USD", "GBp", "JPY"). */
  currency: string;
  /** ISO date the position was opened (YYYY-MM-DD). */
  opened: string;
  /** Trade thesis — the one-liner the user bought it for. */
  thesis: string;
  /** Conviction in the thesis. */
  conviction: Conviction;
  /** Target price for the position. Optional — many users don't set one. */
  target_price?: number;
  /** Stated stop-loss. Optional. */
  stop_loss?: number;
  /** Optional position sizing rationale. */
  size_rationale?: string;

  // --- Added for broker import, income and rebalancing. All optional: rows
  // written before these existed read as a stock held in an unnamed account.
  /** What it is. Drives withholding tax (funds pay gross) and fund tax exemptions. */
  asset_type?: AssetType;
  /** ISIN from the broker. Also tells the issuer's country, which sets withholding tax. */
  isin?: string;
  /** Instrument name as the broker shows it. */
  name?: string;
  /** Where it is held, e.g. "traderepublic" or "ibkr". Tax treatment differs per account. */
  account?: string;
  /** Symbol used for market data (Yahoo), when it differs from `ticker`. */
  data_symbol?: string;
  /** Bonds only: annual coupon in percent of face value. */
  coupon_rate_pct?: number;
  /** Bonds only: coupons per year (1, 2, 4, 12). */
  coupon_frequency?: number;
  /** Bonds only: next coupon payment date (YYYY-MM-DD). */
  next_coupon_date?: string;
  /** Bonds only: face value held (the coupon is paid on this, not on the price). */
  face_value?: number;
  /** Funds only: share of the fund's distributions that is tax-exempt in Germany (Teilfreistellung). Default 30 for ETFs. */
  partial_exemption_pct?: number;
}

export type AssetType = 'stock' | 'etf' | 'bond' | 'cash';

export interface ClosedPosition extends Position {
  closed: string;
  exit_price: number;
  /** Realized P&L in local currency (shares × (exit - avg_cost)). */
  realized_pnl: number;
  /** Realized P&L as a % of cost basis. */
  realized_pnl_pct: number;
  /** Post-mortem: what worked, what didn't. */
  lesson: string;
}

export interface JournalEntry {
  date: string; // YYYY-MM-DD
  /** Free text — what the user wants to remember. */
  text: string;
  /** Optional category for filtering. */
  category?: 'observation' | 'trade' | 'idea' | 'lesson';
}

export interface Portfolio {
  /** Schema version. Bump on breaking changes. */
  version: 1;
  /** ISO date the portfolio was last edited. */
  updated: string;
  /** Total capital in USD. Optional but used by `position-sizing` skill. */
  total_capital_usd?: number;
  /** Max % of capital to risk on a single new position (1.0 = 1%). */
  risk_budget_pct?: number;
  /** Max portfolio drawdown before forced de-risk. */
  max_drawdown_pct?: number;
  /** Open positions. */
  positions: Position[];
  /** Closed positions (history). Newest first. */
  closed: ClosedPosition[];
  /** Journal entries, newest first. */
  journal: JournalEntry[];
  /** Free-form notes — risk preferences, sector tilts, watchlist, etc. */
  notes: string[];
}

const EMPTY_PORTFOLIO: Portfolio = {
  version: 1,
  updated: new Date().toISOString().slice(0, 10),
  positions: [],
  closed: [],
  journal: [],
  notes: [],
};

export class PortfolioStore {
  /**
   * baseDir is resolved per access, not captured at construction.
   *
   * portfolio-tools.ts builds a single store at module load, so a default
   * evaluated in the constructor froze whatever RUBO_HOME held at import
   * time. ES imports are hoisted, so even a harness that sets RUBO_HOME at
   * the top of its file runs that assignment *after* this module has already
   * picked a directory - which is how the behavioural suite twice added a real
   * position to the real portfolio while believing it was writing to scratch.
   */
  constructor(private readonly baseDir?: string) {}

  private getPath(): string {
    return join(this.baseDir ?? getRuboDir(), PORTFOLIO_FILENAME);
  }

  /** Read the full portfolio. Returns empty portfolio if file missing/corrupt. */
  read(): Portfolio {
    const path = this.getPath();
    if (!existsSync(path)) return structuredClone(EMPTY_PORTFOLIO);
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw);
      // Light validation: ensure required fields exist.
      return {
        version: 1,
        updated: parsed.updated ?? new Date().toISOString().slice(0, 10),
        total_capital_usd: parsed.total_capital_usd,
        risk_budget_pct: parsed.risk_budget_pct,
        max_drawdown_pct: parsed.max_drawdown_pct,
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
        closed: Array.isArray(parsed.closed) ? parsed.closed : [],
        journal: Array.isArray(parsed.journal) ? parsed.journal : [],
        notes: Array.isArray(parsed.notes) ? parsed.notes : [],
      };
    } catch {
      return structuredClone(EMPTY_PORTFOLIO);
    }
  }

  /** Write the portfolio to disk. */
  write(portfolio: Portfolio): void {
    const path = this.getPath();
    mkdirSync(dirname(path), { recursive: true });
    portfolio.updated = new Date().toISOString().slice(0, 10);
    writeFileSync(path, JSON.stringify(portfolio, null, 2), 'utf-8');
  }

  /** Patch-style: read, mutate, write. */
  update(mutator: (p: Portfolio) => Portfolio): Portfolio {
    const current = this.read();
    const next = mutator(current);
    this.write(next);
    return next;
  }

  /** Add a position; throws if ticker already open (the user can close first). */
  addPosition(pos: Position): Portfolio {
    return this.update((p) => {
      if (p.positions.some((x) => x.ticker.toUpperCase() === pos.ticker.toUpperCase())) {
        throw new Error(`Position in ${pos.ticker} is already open. Close it first.`);
      }
      return { ...p, positions: [...p.positions, pos] };
    });
  }
}