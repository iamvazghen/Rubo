import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Calibration is the only thing that can ever say whether a grade of 80 means
 * anything, and it had no test at all — so the day real history finally arrives,
 * nothing would have checked the arithmetic that turns it into a verdict.
 *
 * A synthetic ledger does not shorten the wait, but it does mean the answer will
 * be right when the wait is over.
 */
const HOME = mkdtempSync(join(tmpdir(), 'rubo-calib-'));
process.env.RUBO_HOME = HOME;
mkdirSync(join(HOME, 'scores'), { recursive: true });

const { calibration, calibrationProgress } = await import('./grade.js');

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

function ledger(ticker: string, rows: Array<{ days: number; short: number; long: number; price: number }>) {
  writeFileSync(
    join(HOME, 'scores', `${ticker}.jsonl`),
    rows
      .map((r) =>
        JSON.stringify({
          ticker,
          at: ago(r.days),
          short: r.short,
          long: r.long,
          price: r.price,
        }),
      )
      .join('\n') + '\n',
    'utf-8',
  );
}

function reset() {
  rmSync(join(HOME, 'scores'), { recursive: true, force: true });
  mkdirSync(join(HOME, 'scores'), { recursive: true });
}

afterAll(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    // Windows may still hold a handle; the OS reaps the temp directory anyway.
  }
});

describe('calibration', () => {
  test('a grade priced to today becomes an observation without a second grade', () => {
    // The old rule needed a later *recorded* grade, so a single 90-day-old entry
    // counted for nothing. On a monthly review cadence that pushed the first
    // reading out by months.
    reset();
    ledger('AAA', [{ days: 90, short: 85, long: 85, price: 100 }]);

    expect(calibration('long')).toHaveLength(0);

    const buckets = calibration('long', { currentPrices: new Map([['AAA', 120]]) });
    expect(buckets).toHaveLength(1);
    expect(buckets[0].band).toBe('80-100');
    expect(buckets[0].observations).toBe(1);
    expect(buckets[0].meanForwardReturn).toBeCloseTo(20, 5);
  });

  test('grades are bucketed by the score they had at the time', () => {
    reset();
    ledger('AAA', [{ days: 60, short: 90, long: 90, price: 100 }]);
    ledger('BBB', [{ days: 60, short: 40, long: 40, price: 100 }]);

    const prices = new Map([
      ['AAA', 130],
      ['BBB', 90],
    ]);
    const buckets = calibration('long', { currentPrices: prices });
    const top = buckets.find((b) => b.band === '80-100');
    const low = buckets.find((b) => b.band === '35-49');

    expect(top?.meanForwardReturn).toBeCloseTo(30, 5);
    expect(low?.meanForwardReturn).toBeCloseTo(-10, 5);
  });

  test('the two horizons are scored independently', () => {
    // A name can be a fine 20-year hold and a poor 2-year one; bucketing the
    // long grade under the short one would quietly invent a track record.
    reset();
    ledger('AAA', [{ days: 60, short: 20, long: 90, price: 100 }]);

    const prices = new Map([['AAA', 150]]);
    expect(calibration('long', { currentPrices: prices })[0].band).toBe('80-100');
    expect(calibration('short', { currentPrices: prices })[0].band).toBe('0-34');
  });

  test('a grade younger than the floor is not counted', () => {
    reset();
    ledger('AAA', [{ days: 10, short: 85, long: 85, price: 100 }]);
    expect(calibration('long', { currentPrices: new Map([['AAA', 200]]) })).toHaveLength(0);
  });

  test('a ticker with no live price falls back to its own later grade', () => {
    reset();
    ledger('AAA', [
      { days: 90, short: 85, long: 85, price: 100 },
      { days: 20, short: 70, long: 70, price: 110 },
    ]);
    const buckets = calibration('long');
    expect(buckets).toHaveLength(1);
    expect(buckets[0].meanForwardReturn).toBeCloseTo(10, 5);
  });

  test('progress explains an empty result instead of just being empty', () => {
    reset();
    ledger('AAA', [{ days: 12, short: 85, long: 85, price: 100 }]);
    const p = calibrationProgress(30);
    expect(p.gradesRecorded).toBe(1);
    expect(p.tickersTracked).toBe(1);
    expect(p.oldestGradeAgeDays).toBe(12);
    expect(p.daysUntilFirstObservation).toBe(18);
  });

  test('progress reports nothing recorded rather than a misleading countdown', () => {
    reset();
    const p = calibrationProgress(30);
    expect(p.gradesRecorded).toBe(0);
    expect(p.daysUntilFirstObservation).toBeNull();
  });

  test('a mature ledger reports zero days remaining', () => {
    reset();
    ledger('AAA', [{ days: 45, short: 85, long: 85, price: 100 }]);
    expect(calibrationProgress(30).daysUntilFirstObservation).toBe(0);
  });
});
