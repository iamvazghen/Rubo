/**
 * The recurring half: grade a fixed universe, rank it, and say what MOVED since
 * the last run.
 *
 * A monthly "best picks" list that starts from a blank page each time is not an
 * assistant, it is a fresh opinion with a date on it. The universe is fixed so
 * the comparison is like-for-like, and every number is diffed against the score
 * ledger so the report leads with changes rather than levels.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ruboPath } from '../utils/paths.js';
import { PortfolioStore } from '../tools/portfolio/index.js';
import { fetchBundle } from './data.js';
import { gradeBundle, previousScore, recordScore, type Grade } from './grade.js';
import type { Horizon } from './factors.js';

/**
 * Default universe: large, liquid, long-listed US names across sectors. It is a
 * starting point, not a recommendation — override it by writing a JSON array of
 * tickers to `<rubo>/universe.json`.
 */
const DEFAULT_UNIVERSE = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE',
  'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'GS', 'BLK', 'SPGI', 'AXP', 'PGR',
  'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'AMGN', 'ELV',
  'PG', 'KO', 'PEP', 'COST', 'WMT', 'MCD', 'HD', 'NKE', 'PM', 'MDLZ',
  'XOM', 'CVX', 'CAT', 'HON', 'UNP', 'GE', 'LMT', 'DE', 'ETN', 'LIN',
];

export function universePath(): string {
  return ruboPath('universe.json');
}

export function loadUniverse(): string[] {
  const path = universePath();
  if (!existsSync(path)) return DEFAULT_UNIVERSE;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    const list = Array.isArray(parsed) ? parsed : parsed.tickers;
    if (Array.isArray(list) && list.length > 0) {
      return list.map((t: unknown) => String(t).trim().toUpperCase()).filter(Boolean);
    }
  } catch {
    // Fall through to the default rather than failing a scheduled run.
  }
  return DEFAULT_UNIVERSE;
}

export function saveUniverse(tickers: string[]): string[] {
  const clean = [...new Set(tickers.map((t) => t.trim().toUpperCase()).filter(Boolean))];
  const path = universePath();
  mkdirSync(ruboPath(), { recursive: true });
  writeFileSync(path, JSON.stringify(clean, null, 2), 'utf-8');
  return clean;
}

/**
 * Bounded-concurrency map. Two provider calls per ticker times fifty names is
 * a hundred requests; fired all at once that trips Finnhub's 60/min and
 * Tiingo's hourly symbol cap, and a scheduled run that gets rate-limited at
 * 3am reports garbage. Four at a time keeps a full universe inside the limits.
 */
async function mapLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface RankedEntry {
  ticker: string;
  short: number;
  long: number;
  /** Change vs the previous ledger entry, null on a first run. */
  shortDelta: number | null;
  longDelta: number | null;
  coverage: number;
  verdictShort: string;
  verdictLong: string;
  error?: string;
}

export interface UniverseReport {
  at: string;
  horizon: Horizon;
  graded: number;
  failed: string[];
  top: RankedEntry[];
  risers: RankedEntry[];
  fallers: RankedEntry[];
  holdings: HoldingReview[];
  markdown: string;
}

export interface HoldingReview {
  ticker: string;
  score: number;
  delta: number | null;
  verdict: string;
  /** Set when the holding has decayed enough to deserve a look. */
  flag?: string;
}

const DECAY_FLAG_DROP = 10;
const DECAY_FLAG_LEVEL = 50;

/**
 * Grade every name in the universe, append each grade to the ledger, and build
 * the ranked report. `concurrency` is deliberately low; see mapLimited.
 */
export async function runUniverseReport(options: {
  horizon?: Horizon;
  topN?: number;
  universe?: string[];
  concurrency?: number;
} = {}): Promise<UniverseReport> {
  const horizon = options.horizon ?? 'long';
  const topN = options.topN ?? 10;
  const tickers = options.universe ?? loadUniverse();
  const at = new Date().toISOString();

  const graded = await mapLimited(tickers, options.concurrency ?? 4, async (ticker) => {
    try {
      const grade = gradeBundle(await fetchBundle(ticker));
      const prev = previousScore(ticker, at);
      recordScore(grade);
      return { grade, prev, ticker, error: undefined as string | undefined };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { grade: null, prev: null, ticker, error: message };
    }
  });

  const failed = graded.filter((g) => g.grade === null).map((g) => `${g.ticker} (${g.error})`);

  const entries: RankedEntry[] = graded
    .filter((g): g is typeof g & { grade: Grade } => g.grade !== null)
    .map(({ grade, prev }) => ({
      ticker: grade.ticker,
      short: grade.short.score,
      long: grade.long.score,
      shortDelta: prev ? grade.short.score - prev.short : null,
      longDelta: prev ? grade.long.score - prev.long : null,
      coverage: horizon === 'short' ? grade.short.coverage : grade.long.coverage,
      verdictShort: grade.short.verdict,
      verdictLong: grade.long.verdict,
    }));

  const scoreOf = (e: RankedEntry) => (horizon === 'short' ? e.short : e.long);
  const deltaOf = (e: RankedEntry) => (horizon === 'short' ? e.shortDelta : e.longDelta);

  const top = [...entries].sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, topN);
  const moved = entries.filter((e) => deltaOf(e) !== null);
  const risers = [...moved].sort((a, b) => (deltaOf(b) ?? 0) - (deltaOf(a) ?? 0)).slice(0, 5);
  const fallers = [...moved].sort((a, b) => (deltaOf(a) ?? 0) - (deltaOf(b) ?? 0)).slice(0, 5);

  const holdings = await reviewHoldings(horizon, entries);

  const report: UniverseReport = {
    at,
    horizon,
    graded: entries.length,
    failed,
    top,
    risers,
    fallers,
    holdings,
    markdown: '',
  };
  report.markdown = renderMarkdown(report);
  writeReport(report);
  return report;
}

/**
 * Exit discipline: the existing trade-review skill only looks at trades already
 * closed, which is the one moment the information is worthless. This grades the
 * names actually held and flags the ones whose case has decayed.
 */
async function reviewHoldings(horizon: Horizon, universeEntries: RankedEntry[]): Promise<HoldingReview[]> {
  const portfolio = new PortfolioStore().read();
  const held = portfolio.positions.map((p) => p.ticker.toUpperCase());
  if (held.length === 0) return [];

  const byTicker = new Map(universeEntries.map((e) => [e.ticker, e]));
  const reviews: HoldingReview[] = [];

  for (const ticker of held) {
    let entry = byTicker.get(ticker);
    if (!entry) {
      // Held but outside the universe — grade it anyway, it is the user's money.
      try {
        const grade = gradeBundle(await fetchBundle(ticker));
        const prev = previousScore(ticker, grade.asOf);
        recordScore(grade);
        entry = {
          ticker,
          short: grade.short.score,
          long: grade.long.score,
          shortDelta: prev ? grade.short.score - prev.short : null,
          longDelta: prev ? grade.long.score - prev.long : null,
          coverage: horizon === 'short' ? grade.short.coverage : grade.long.coverage,
          verdictShort: grade.short.verdict,
          verdictLong: grade.long.verdict,
        };
      } catch {
        continue;
      }
    }

    const score = horizon === 'short' ? entry.short : entry.long;
    const delta = horizon === 'short' ? entry.shortDelta : entry.longDelta;
    const verdict = horizon === 'short' ? entry.verdictShort : entry.verdictLong;

    let flag: string | undefined;
    if (delta !== null && delta <= -DECAY_FLAG_DROP) {
      flag = `down ${Math.abs(delta)} points since the last run`;
    } else if (score < DECAY_FLAG_LEVEL) {
      flag = `below ${DECAY_FLAG_LEVEL} on the ${horizon} horizon`;
    }

    reviews.push({ ticker, score, delta, verdict, flag });
  }

  return reviews.sort((a, b) => a.score - b.score);
}

function sign(n: number | null): string {
  if (n === null) return 'new';
  return n > 0 ? `+${n}` : String(n);
}

function renderMarkdown(r: UniverseReport): string {
  const horizonLabel = r.horizon === 'short' ? 'short term (1-3y)' : 'long term (20y+)';
  const lines: string[] = [];

  lines.push(`# Investment review - ${r.at.slice(0, 10)}`);
  lines.push('');
  lines.push(`Horizon: **${horizonLabel}**. Graded ${r.graded} names.`);
  lines.push('');

  lines.push(`## Top ${r.top.length}`);
  lines.push('');
  lines.push('| # | Ticker | Score | Change | Verdict | Coverage |');
  lines.push('|---|--------|-------|--------|---------|----------|');
  r.top.forEach((e, i) => {
    const score = r.horizon === 'short' ? e.short : e.long;
    const delta = r.horizon === 'short' ? e.shortDelta : e.longDelta;
    const verdict = r.horizon === 'short' ? e.verdictShort : e.verdictLong;
    lines.push(`| ${i + 1} | ${e.ticker} | ${score} | ${sign(delta)} | ${verdict} | ${e.coverage}% |`);
  });
  lines.push('');

  if (r.risers.length > 0) {
    lines.push('## Biggest improvements');
    lines.push('');
    for (const e of r.risers) {
      const delta = r.horizon === 'short' ? e.shortDelta : e.longDelta;
      const score = r.horizon === 'short' ? e.short : e.long;
      lines.push(`- **${e.ticker}** ${sign(delta)} to ${score}`);
    }
    lines.push('');
  }

  if (r.fallers.length > 0) {
    lines.push('## Biggest deteriorations');
    lines.push('');
    for (const e of r.fallers) {
      const delta = r.horizon === 'short' ? e.shortDelta : e.longDelta;
      const score = r.horizon === 'short' ? e.short : e.long;
      lines.push(`- **${e.ticker}** ${sign(delta)} to ${score}`);
    }
    lines.push('');
  }

  if (r.holdings.length > 0) {
    lines.push('## Your holdings');
    lines.push('');
    for (const h of r.holdings) {
      const flag = h.flag ? ` — **${h.flag}**` : '';
      lines.push(`- **${h.ticker}** ${h.score} (${sign(h.delta)}), ${h.verdict}${flag}`);
    }
    lines.push('');
  }

  if (r.failed.length > 0) {
    lines.push('## Could not grade');
    lines.push('');
    lines.push(r.failed.join(', '));
    lines.push('');
  }

  return lines.join('\n');
}

function writeReport(r: UniverseReport): string {
  const dir = ruboPath('reports');
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${r.at.slice(0, 10)}-${r.horizon}.md`;
  writeFileSync(path, r.markdown, 'utf-8');
  return path;
}
