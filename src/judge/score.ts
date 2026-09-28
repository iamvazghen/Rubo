import { existsSync, readFileSync } from 'node:fs';
import type { MarketData } from '../market/yahoo.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { ruboPath } from '../utils/paths.js';

/**
 * Scores Jev's judgements against what happened, like the grade ledger.
 *
 * Dividend-cut probabilities resolve by themselves: a year after the judgement,
 * the payment history says whether the dividend was cut or suspended. The
 * Brier score (mean squared error of the probability, lower is better) is
 * compared with always guessing the observed base rate, so "better than
 * naive" means something. Thesis, news and debate judgements have no automatic
 * outcome; they are counted, not scored.
 */

const YEAR = 365 * 86_400_000;

export interface Judgement {
  at: string;
  kind: string;
  subject: string;
  answers: Record<string, { noul?: number; choice?: string }>;
}

export function readJudgements(path = ruboPath('judgements.jsonl')): Judgement[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line) as Judgement] : []; } catch { return []; }
  });
}

/**
 * Was the dividend cut or suspended within a year of `at`? Compared with the
 * last payment before the judgement; null when that is not yet known (less
 * than a year ago, or no earlier payment to compare with).
 */
export function dividendCutOutcome(dividends: { exDate: string; amount: number }[], at: string, now: number): boolean | null {
  const start = Date.parse(at);
  if (now < start + YEAR) return null;
  const before = dividends.filter((d) => Date.parse(d.exDate) < start).at(-1);
  if (!before) return null;
  const window = dividends.filter((d) => Date.parse(d.exDate) >= start && Date.parse(d.exDate) < start + YEAR);
  return window.length === 0 || window.some((d) => d.amount < before.amount * 0.995);
}

export interface ScoreReport {
  counts: Record<string, number>;
  resolved: { subject: string; at: string; p: number; cut: boolean }[];
  brier: number | null;
  baseline: number | null;
  pending: number;
}

export async function scoreJudgements(market: MarketData, now = Date.now(), judgements = readJudgements()): Promise<ScoreReport> {
  const counts: Record<string, number> = {};
  for (const j of judgements) counts[j.kind] = (counts[j.kind] ?? 0) + 1;

  // The same company is judged weekly; one judgement per company and month is scored.
  const seen = new Set<string>();
  const cut = judgements.filter((j) => j.kind === 'dividend_safety' && typeof j.answers.cut?.noul === 'number').filter((j) => {
    const k = `${j.subject}:${j.at.slice(0, 7)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });

  const symbolOf = new Map(new PortfolioStore().read().positions.map((p) => [p.ticker, p.data_symbol ?? p.ticker]));
  const history = new Map<string, { exDate: string; amount: number }[] | null>();
  const resolved: ScoreReport['resolved'] = [];
  let pending = 0;
  for (const j of cut) {
    if (now < Date.parse(j.at) + YEAR) { pending++; continue; }
    const symbol = symbolOf.get(j.subject) ?? j.subject;
    if (!history.has(symbol)) history.set(symbol, (await market.dividendHistory(symbol))?.dividends ?? null);
    const outcome = history.get(symbol) ? dividendCutOutcome(history.get(symbol)!, j.at, now) : null;
    if (outcome == null) { pending++; continue; }
    resolved.push({ subject: j.subject, at: j.at.slice(0, 10), p: j.answers.cut!.noul!, cut: outcome });
  }

  const n = resolved.length;
  const brier = n ? resolved.reduce((s, r) => s + (r.p - (r.cut ? 1 : 0)) ** 2, 0) / n : null;
  const rate = n ? resolved.filter((r) => r.cut).length / n : 0;
  return { counts, resolved, brier, baseline: n ? rate * (1 - rate) : null, pending };
}

export function describeScores(r: ScoreReport): string {
  const total = Object.values(r.counts).reduce((s, v) => s + v, 0);
  if (total === 0) return 'No Jev judgements yet. They are logged as Rubo uses dividend_safety, thesis_check, news_materiality and run_debate.';
  const lines = [`Jev judgements logged: ${total} (${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(', ')})`];
  if (r.brier == null) {
    lines.push(`Dividend-cut calls resolve a year after they are made; none has yet (${r.pending} waiting).`);
  } else {
    const verdict = r.brier < r.baseline! ? 'better than' : 'not better than';
    lines.push(
      `Dividend-cut calls scored: ${r.resolved.length} (${r.resolved.filter((x) => x.cut).length} cuts), ${r.pending} still waiting.`,
      `Brier score ${r.brier.toFixed(3)} vs ${r.baseline!.toFixed(3)} for always guessing the base rate: ${verdict} naive (lower is better).`,
      ...r.resolved.slice(-5).map((x) => `  ${x.at} ${x.subject}: ${Math.round(x.p * 100)} % → ${x.cut ? 'cut' : 'kept'}`),
    );
  }
  lines.push('Thesis, news and debate judgements have no automatic outcome, so they are logged, not scored. Special dividends can look like cuts.');
  return lines.join('\n');
}
