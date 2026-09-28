import { randomBytes } from 'node:crypto';
import { yahoo, type MarketData } from '../market/yahoo.js';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import type { CronJob, CronStore } from '../cron/types.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { baseCurrency, timeZone } from '../utils/locale.js';
import { buildIncomeCalendar } from './calendar.js';
import { beforeExMessage, cutMessage, payMessage } from './messages.js';
import { allocate, planFor, type Allocation } from './plan.js';
import { incomeStore, type IncomeEvent } from './store.js';
import { dividendCutRisk, jevAvailable } from '../judge/jev.js';

/** Only payments this close get reminders; the nightly refresh rolls the window. */
const REMINDER_WINDOW_DAYS = 45;
const JOB_PREFIX = 'income:';
const REFRESH_JOB = 'income:refresh';

/** `day` at `hour`:00 wall-clock time in `tz`, as an ISO instant. */
export function zonedIso(day: string, hour: number, tz = timeZone()): string {
  const guess = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(guess)).map((p) => [p.type, p.value]),
  );
  const shown = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:00Z`);
  return new Date(guess - (shown - guess)).toISOString();
}

export interface PlannedEvent {
  event: IncomeEvent;
  allocations: Allocation[];
  override: boolean;
}

/** Apply the owner's plan to one payment, pricing reinvest/repurpose targets in the base currency. */
export async function planEvent(event: IncomeEvent, market: MarketData): Promise<PlannedEvent> {
  const { parts, override } = planFor(incomeStore.plan(), event.ticker);
  const prices = new Map<string, number>();
  for (const part of parts) {
    const symbol = part.target ?? (part.action === 'reinvest' ? event.ticker : undefined);
    if (!symbol || prices.has(symbol)) continue;
    const q = await market.quote(symbol);
    const fx = q ? (q.currency === baseCurrency() ? 1 : await market.rate(q.currency, baseCurrency())) : null;
    if (q && fx) prices.set(symbol, q.price * fx);
  }
  const allocations = allocate(event.tax.net, parts, (target, action) =>
    prices.get(target ?? (action === 'reinvest' ? event.ticker : '')),
  );
  return { event, allocations, override };
}

function upsertJob(store: CronStore, name: string, at: string, message: string, now: number): string | undefined {
  const nextRunAtMs = computeNextRunAtMs({ kind: 'at', at }, now);
  const existing = store.jobs.find((j) => j.name === name);
  if (!nextRunAtMs) return existing?.id; // already fired or in the past
  if (existing) {
    existing.schedule = { kind: 'at', at };
    existing.payload = { message, direct: true };
    existing.enabled = true;
    existing.state.nextRunAtMs = nextRunAtMs;
    existing.updatedAtMs = now;
    return existing.id;
  }
  const job: CronJob = {
    id: randomBytes(8).toString('hex'), name, description: 'Income reminder (computed, sent verbatim)',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule: { kind: 'at', at },
    payload: { message, direct: true }, fulfillment: 'once',
    state: { nextRunAtMs, consecutiveErrors: 0, scheduleErrorCount: 0 },
  };
  store.jobs.push(job);
  return job.id;
}

/**
 * Rebuild the income calendar from current holdings, keep confirmed payments,
 * and (re)schedule reminders for the next weeks. Returns text for the owner only
 * when something needs attention (a cut), otherwise an empty string.
 *
 * Pass the cron runner's live store when called from a cron job; standalone
 * calls load and save it themselves.
 */
export async function refreshIncome(p: { cronStore?: CronStore; market?: MarketData; now?: Date } = {}): Promise<string> {
  const market = p.market ?? yahoo;
  const now = p.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const positions = new PortfolioStore().read().positions;
  const dataSymbol = new Map(positions.map((x) => [x.ticker, x.data_symbol ?? x.ticker]));
  const ledger = incomeStore.ledger();
  const previous = incomeStore.calendar().events;

  const fresh = await buildIncomeCalendar({ positions, market, profile: incomeStore.tax(), ledger, today });
  const kept = previous.filter((e) => e.status === 'paid' || e.status === 'skipped');
  const done = new Set(kept.map((e) => e.id));
  const byId = new Map(previous.map((e) => [e.id, e]));

  const store = p.cronStore ?? loadCronStore();
  const alerts: string[] = [];
  const events: IncomeEvent[] = [...kept];
  const soon = now.getTime() + REMINDER_WINDOW_DAYS * 86_400_000;
  let reserve = ledger.reserve;

  for (const e of fresh) {
    if (done.has(e.id)) continue;
    const before = byId.get(e.id);
    e.reminderJobs = before?.reminderJobs;
    // A cut is news once, when the announced amount first shows up lower.
    if (e.status === 'announced' && e.previousPerShare && e.perShare < e.previousPerShare * 0.995 && before?.status !== 'announced') {
      alerts.push(cutMessage(e));
    }
    if (Date.parse(`${e.payDate}T00:00:00Z`) <= soon) {
      // Jev's cut probability for payments that get a reminder (cached a week per company).
      if (jevAvailable() && e.kind === 'dividend') {
        const f = await market.fundamentals(dataSymbol.get(e.ticker) ?? e.ticker);
        if (f) e.cutRisk = (await dividendCutRisk(e.ticker, f)) ?? undefined;
      }
      const planned = await planEvent(e, market);
      const toReserve = planned.allocations.filter((a) => a.action === 'reserve').reduce((s, a) => s + a.amount, 0);
      reserve += toReserve;
      e.reminderJobs = {
        beforeEx: upsertJob(store, `${JOB_PREFIX}${e.id}:ex`, zonedIso(isoMinusDays(e.exDate, 2), 9), beforeExMessage(e), now.getTime()),
        onPay: upsertJob(store, `${JOB_PREFIX}${e.id}:pay`, zonedIso(e.payDate, 10), payMessage(e, planned.allocations, planned.override, reserve), now.getTime()),
      };
    }
    events.push(e);
  }

  // Reminders for payments that disappeared (position sold, date moved) are
  // dropped. The refresh job shares the prefix and must never be.
  const live = new Set(events.flatMap((e) => [`${JOB_PREFIX}${e.id}:ex`, `${JOB_PREFIX}${e.id}:pay`]));
  live.add(REFRESH_JOB);
  store.jobs = store.jobs.filter((j) => !j.name.startsWith(JOB_PREFIX) || live.has(j.name));

  events.sort((a, b) => a.payDate.localeCompare(b.payDate));
  incomeStore.saveCalendar(events);
  if (!p.cronStore) saveCronStore(store);
  return alerts.join('\n');
}

function isoMinusDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

/** Make sure the nightly refresh job exists (called when the gateway starts). */
export function ensureIncomeRefreshJob(): void {
  const store = loadCronStore();
  const name = REFRESH_JOB;
  if (store.jobs.some((j) => j.name === name)) return;
  const now = Date.now();
  const schedule = { kind: 'cron' as const, expr: '30 6 * * *', tz: timeZone() };
  store.jobs.push({
    id: randomBytes(8).toString('hex'), name, description: 'Nightly: refresh the income calendar and schedule reminders',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule,
    payload: { message: '', handler: 'income_refresh' }, fulfillment: 'keep',
    state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
  });
  saveCronStore(store);
}
