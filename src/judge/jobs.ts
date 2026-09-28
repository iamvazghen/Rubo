import { randomBytes } from 'node:crypto';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import { timeZone } from '../utils/locale.js';
import { jevAvailable } from './jev.js';

export const THESIS_JOB = 'thesis:monthly';

/**
 * Monthly: for each holding with a real thesis, gather the month's results and
 * news and ask Jev whether the thesis still holds. The owner hears only about
 * theses that are in doubt. A model job (it has to gather the evidence), so it
 * runs through the normal agent with the thesis_check tool; silent otherwise.
 * Created only when a TypeSafe key is set.
 */
export const THESIS_JOB_MESSAGE = [
  'Monthly thesis check.',
  '1. Read the portfolio (portfolio_view). Skip holdings whose thesis is only an import placeholder ("Imported from …"); list their tickers once at the end so the owner can write a thesis for them.',
  '2. For every other holding, gather the last month of evidence: results, guidance, dividend news, major events, with dates and numbers.',
  '3. Call thesis_check with the ticker and that evidence.',
  '4. Report only holdings where intact_probability is below 0.5 or the direction is "weakens": ticker, the probability, and the one or two facts behind it. Present the numbers as Jev probabilities, never as verdicts.',
  'If nothing is in doubt and no holding lacks a thesis, reply exactly HEARTBEAT_OK.',
].join('\n');

export function ensureThesisCheckJob(): void {
  if (!jevAvailable()) return;
  const store = loadCronStore();
  if (store.jobs.some((j) => j.name === THESIS_JOB)) return;
  const now = Date.now();
  // The 15th, away from the reviews on the 1st.
  const schedule = { kind: 'cron' as const, expr: '0 9 15 * *', tz: timeZone() };
  store.jobs.push({
    id: randomBytes(8).toString('hex'), name: THESIS_JOB, description: 'Monthly: does each holding\'s thesis still hold? (Jev)',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule,
    payload: { message: THESIS_JOB_MESSAGE }, fulfillment: 'keep',
    state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
  });
  saveCronStore(store);
}
