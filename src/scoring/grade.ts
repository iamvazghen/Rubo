/**
 * Composite grading and the score ledger.
 *
 * The ledger is the point. A grade that only ever appears in a chat reply is an
 * opinion; a grade appended to `<rubo>/scores/<TICKER>.jsonl` with the price
 * at the time is a track record. Every later run can then say what changed and,
 * once enough time has passed, whether the high grades actually did better.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { ruboPath } from '../utils/paths.js';
import { fetchBundle, latestPrice, type TickerBundle } from './data.js';
import { FACTORS, type Horizon } from './factors.js';

export interface FactorScore {
  id: string;
  label: string;
  score: number;
  weight: number;
  detail: string;
}

export interface HorizonGrade {
  horizon: Horizon;
  score: number;
  verdict: string;
  /** Share of the horizon's total weight that had usable data, 0-100. */
  coverage: number;
  factors: FactorScore[];
  missing: string[];
}

export interface Grade {
  ticker: string;
  /** The US-listed symbol the fundamentals came from; differs for a foreign listing. */
  gradedAs: string;
  /** Present when a foreign ticker was graded through its US line — quote it to the user. */
  listingNote?: string;
  asOf: string;
  price: number | null;
  short: HorizonGrade;
  long: HorizonGrade;
  sources: string[];
  dataGaps: string[];
}

/** Bands are fixed so that "71" means the same thing in every report. */
export function verdictFor(score: number, horizon: Horizon): string {
  const long = horizon === 'long';
  if (score >= 80) return long ? 'exceptional compounder' : 'strong setup';
  if (score >= 65) return long ? 'high-quality holding' : 'favourable';
  if (score >= 50) return long ? 'acceptable, not special' : 'mixed';
  if (score >= 35) return long ? 'structurally weak' : 'unfavourable';
  return long ? 'avoid for a 20-year hold' : 'avoid';
}

function gradeHorizon(b: TickerBundle, horizon: Horizon): HorizonGrade {
  const factors: FactorScore[] = [];
  const missing: string[] = [];
  let weighted = 0;
  let usedWeight = 0;
  let totalWeight = 0;

  for (const f of FACTORS) {
    const weight = f.weights[horizon];
    if (weight <= 0) continue;
    totalWeight += weight;

    const score = f.score(b);
    if (score === null) {
      missing.push(f.label);
      continue;
    }

    weighted += score * weight;
    usedWeight += weight;
    factors.push({ id: f.id, label: f.label, score, weight, detail: f.detail(b) });
  }

  // Renormalise over the factors that scored: a missing input must not read as
  // a zero, or a data gap would masquerade as a bad company.
  const score = usedWeight > 0 ? weighted / usedWeight : 0;
  const coverage = totalWeight > 0 ? (usedWeight / totalWeight) * 100 : 0;

  return {
    horizon,
    score: Math.round(score),
    verdict: verdictFor(score, horizon),
    coverage: Math.round(coverage),
    factors: factors.sort((a, b2) => b2.weight * b2.score - a.weight * a.score),
    missing,
  };
}

export function gradeBundle(b: TickerBundle): Grade {
  return {
    ticker: b.ticker,
    gradedAs: b.gradedAs,
    listingNote: b.listingNote,
    asOf: b.asOf,
    price: latestPrice(b),
    short: gradeHorizon(b, 'short'),
    long: gradeHorizon(b, 'long'),
    sources: b.sources,
    dataGaps: b.missing,
  };
}

export async function gradeTicker(ticker: string): Promise<Grade> {
  return gradeBundle(await fetchBundle(ticker));
}

// ------------------------------------------------------------------ ledger

export interface ScoreRecord {
  ticker: string;
  at: string;
  short: number;
  long: number;
  shortCoverage: number;
  longCoverage: number;
  /** Close at grade time. Null when the price provider was unreachable. */
  price: number | null;
}

function scoresDir(): string {
  const dir = ruboPath('scores');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function ledgerPath(ticker: string): string {
  return `${scoresDir()}/${ticker.toUpperCase()}.jsonl`;
}

export function recordScore(g: Grade): ScoreRecord {
  const record: ScoreRecord = {
    ticker: g.ticker,
    at: g.asOf,
    short: g.short.score,
    long: g.long.score,
    shortCoverage: g.short.coverage,
    longCoverage: g.long.coverage,
    price: g.price,
  };
  appendFileSync(ledgerPath(g.ticker), `${JSON.stringify(record)}\n`, 'utf-8');
  return record;
}

export function readLedger(ticker: string): ScoreRecord[] {
  const path = ledgerPath(ticker);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ScoreRecord];
      } catch {
        return [];
      }
    });
}

/** Every ticker the ledger has a grade for. */
export function readLedgerTickers(): string[] {
  return readdirSync(scoresDir())
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, '').toUpperCase());
}
export function readAllLedgers(): ScoreRecord[] {
  const dir = scoresDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => readLedger(f.replace(/\.jsonl$/, '')));
}

/** The previous grade for a ticker, so a report can show the move, not just the level. */
export function previousScore(ticker: string, beforeIso?: string): ScoreRecord | null {
  const records = readLedger(ticker);
  const cutoff = beforeIso ? Date.parse(beforeIso) : Date.now();
  const earlier = records.filter((r) => Date.parse(r.at) < cutoff);
  return earlier.length > 0 ? earlier[earlier.length - 1] : null;
}

// -------------------------------------------------------------- calibration

export interface CalibrationBucket {
  band: string;
  observations: number;
  meanForwardReturn: number;
  medianHoldDays: number;
}

export interface CalibrationOptions {
  /** A grade has to be this old before its forward return means anything. */
  minDays?: number;
  /**
   * Today's price per ticker. Supplying it is what makes calibration possible
   * on a realistic schedule — see the note on the function below.
   */
  currentPrices?: ReadonlyMap<string, number>;
}

/** What calibration is still waiting for, so an empty result can explain itself. */
export interface CalibrationProgress {
  gradesRecorded: number;
  tickersTracked: number;
  oldestGradeAgeDays: number | null;
  daysUntilFirstObservation: number | null;
}

/**
 * Did the high grades actually do better? Buckets each graded ticker's forward
 * return by the grade it had at the time.
 *
 * The forward leg is today's price when `currentPrices` supplies one, and
 * otherwise the most recent *recorded* grade for that ticker. That fallback
 * alone made the metric almost unreachable in practice: it needs a second
 * grade at least minDays after the first, and the reviews that write grades run
 * monthly — 1 Sep to 1 Oct is 30 days, but 1 Oct to 1 Nov is the first pair a
 * 30-day floor actually admits, so the first reading would have landed in
 * November. Priced against today instead, every grade becomes an observation
 * the moment it is old enough, with no second grade needed.
 *
 * It still needs elapsed time, which nothing can shortcut. What it must not do
 * is stay silent about why it is empty — see calibrationProgress().
 */
export function calibration(
  horizon: Horizon,
  options: CalibrationOptions | number = {},
): CalibrationBucket[] {
  // Kept callable as calibration(horizon, 30).
  const { minDays = 30, currentPrices } =
    typeof options === 'number' ? { minDays: options, currentPrices: undefined } : options;
  const byTicker = new Map<string, ScoreRecord[]>();
  for (const r of readAllLedgers()) {
    if (r.price === null) continue;
    const list = byTicker.get(r.ticker) ?? [];
    list.push(r);
    byTicker.set(r.ticker, list);
  }

  const bands = [
    { band: '80-100', lo: 80, hi: 101 },
    { band: '65-79', lo: 65, hi: 80 },
    { band: '50-64', lo: 50, hi: 65 },
    { band: '35-49', lo: 35, hi: 50 },
    { band: '0-34', lo: 0, hi: 35 },
  ];
  const buckets = bands.map((b) => ({ ...b, returns: [] as number[], holds: [] as number[] }));

  const now = Date.now();
  for (const [ticker, records] of byTicker) {
    const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const livePrice = currentPrices?.get(ticker.toUpperCase());

    // With a live price every grade is a candidate; without one, the newest
    // grade is the yardstick and cannot also be an observation.
    const exitPrice = livePrice ?? sorted[sorted.length - 1].price;
    const exitAtMs = livePrice !== undefined ? now : Date.parse(sorted[sorted.length - 1].at);
    if (exitPrice === null || exitPrice <= 0) continue;
    const candidates = livePrice !== undefined ? sorted : sorted.slice(0, -1);

    for (const r of candidates) {
      if (r.price === null || r.price <= 0) continue;
      const days = (exitAtMs - Date.parse(r.at)) / 86_400_000;
      if (days < minDays) continue;

      const score = horizon === 'short' ? r.short : r.long;
      const bucket = buckets.find((b) => score >= b.lo && score < b.hi);
      if (!bucket) continue;
      bucket.returns.push(((exitPrice - r.price) / r.price) * 100);
      bucket.holds.push(days);
    }
  }

  return buckets
    .filter((b) => b.returns.length > 0)
    .map((b) => ({
      band: b.band,
      observations: b.returns.length,
      meanForwardReturn: b.returns.reduce((a, x) => a + x, 0) / b.returns.length,
      medianHoldDays: [...b.holds].sort((a, x) => a - x)[Math.floor(b.holds.length / 2)],
    }));
}

/**
 * Why calibration is empty, in numbers.
 *
 * "No grade is yet 30 days old" is true but unactionable — it does not say
 * whether anything is being recorded at all, or when the wait ends. A reader
 * cannot tell a working system that needs patience from a broken one.
 */
export function calibrationProgress(minDays = 30): CalibrationProgress {
  const records = readAllLedgers().filter((r) => r.price !== null);
  if (records.length === 0) {
    return {
      gradesRecorded: 0,
      tickersTracked: 0,
      oldestGradeAgeDays: null,
      daysUntilFirstObservation: null,
    };
  }
  const now = Date.now();
  const oldestMs = Math.min(...records.map((r) => Date.parse(r.at)));
  const ageDays = (now - oldestMs) / 86_400_000;
  return {
    gradesRecorded: records.length,
    tickersTracked: new Set(records.map((r) => r.ticker.toUpperCase())).size,
    oldestGradeAgeDays: Math.floor(ageDays),
    daysUntilFirstObservation: Math.max(0, Math.ceil(minDays - ageDays)),
  };
}
