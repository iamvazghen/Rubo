/**
 * Live ticker watchlist. /watch AAPL MSFT NVDA registers tickers; the
 * sidebar fetches each ticker's snapshot every 30 seconds and renders a
 * compact price + ascii sparkline.
 *
 * Ponytail: the component does not embed a fetch loop. cli.ts calls
 * `setQuotes()` whenever new data arrives (driven by its own setInterval),
 * keeping this component pure-render.
 */
import { Box, Spacer, Text } from '@mariozechner/pi-tui';
import { theme } from '../theme.js';
import { pctChange, sparkline } from '../utils/sparkline.js';

export interface WatchQuote {
  symbol: string;
  price: number | null;
  history: number[];
  updatedAt: number;
}

export class WatchlistComponent extends Box {
  private tickers: string[] = [];
  private quotes: Map<string, WatchQuote> = new Map();

  constructor(_width = 22) {
    super(1, 0, (text) => theme.mutedDark(text));
    this.refresh();
  }

  setTickers(tickers: string[]) {
    this.tickers = tickers.map((t) => t.toUpperCase());
    // Drop quotes for tickers that are no longer watched.
    for (const t of [...this.quotes.keys()]) {
      if (!this.tickers.includes(t)) this.quotes.delete(t);
    }
    this.refresh();
  }

  setQuote(symbol: string, price: number | null, history: number[]) {
    this.quotes.set(symbol.toUpperCase(), {
      symbol: symbol.toUpperCase(),
      price,
      history,
      updatedAt: Date.now(),
    });
    this.refresh();
  }

  hasTickers(): boolean {
    return this.tickers.length > 0;
  }

  private refresh() {
    this.clear();

    // Nothing watched means nothing to show. A bordered box containing only
    // a header and a hint is chrome with no content, and it appeared on every
    // startup. The command is documented in /help where it belongs.
    if (this.tickers.length === 0) return;

    this.addChild(new Text(theme.primary('Watchlist'), 0, 0));
    this.addChild(new Spacer(1));

    for (const t of this.tickers) {
      const q = this.quotes.get(t);
      if (!q) {
        this.addChild(new Text(`${theme.muted(t)} ${theme.dim('…')}`, 0, 0));
        continue;
      }
      const priceStr = q.price != null ? `$${q.price.toFixed(2)}` : '—';
      const spark = sparkline(q.history, 6);
      const change = pctChange(q.history);
      const changeStr = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
      const changeColor = change >= 0 ? theme.success : theme.error;

      const line = `${theme.bold(t.padEnd(6))} ${theme.primary(priceStr.padStart(9))}  ${theme.muted(spark)} ${changeColor(changeStr)}`;
      this.addChild(new Text(line, 0, 0));
    }
  }
}
