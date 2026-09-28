import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { yahoo, type MarketData } from '../market/yahoo.js';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import { allowanceLeft, basePerAllowanceUnit, incomeStore } from '../income/store.js';
import { planFor } from '../income/plan.js';
import { PortfolioStore, type Position } from '../tools/portfolio/store.js';
import { baseCurrency, money, timeZone } from '../utils/locale.js';
import { ruboPath } from '../utils/paths.js';
import { bucketOf, DEFAULT_TARGETS, proposeRebalance, type Proposal, type TargetMode, type Targets, type ValuedHolding } from './engine.js';

const targetsPath = () => ruboPath('rebalance', 'targets.json');

export function loadTargets(): Targets {
  if (!existsSync(targetsPath())) return structuredClone(DEFAULT_TARGETS);
  try { return { ...structuredClone(DEFAULT_TARGETS), ...JSON.parse(readFileSync(targetsPath(), 'utf8')) }; }
  catch { return structuredClone(DEFAULT_TARGETS); }
}

export function saveTargets(t: Targets): void {
  mkdirSync(dirname(targetsPath()), { recursive: true });
  writeFileSync(targetsPath(), JSON.stringify({ ...t, updated_at: new Date().toISOString() }, null, 2), 'utf8');
}

/** Base currency per unit of `currency`. */
const toBase = async (market: MarketData, currency: string) => (currency === baseCurrency() ? 1 : market.rate(currency, baseCurrency()));

export async function valueHoldings(market: MarketData): Promise<{ holdings: ValuedHolding[]; missing: string[] }> {
  const holdings: ValuedHolding[] = [];
  const missing: string[] = [];
  for (const position of new PortfolioStore().read().positions) {
    if (position.asset_type === 'cash') {
      const fx = await toBase(market, position.currency);
      if (fx) holdings.push({ position, price_local: 1, base_per_local: fx, base_per_cost: fx, value: position.shares * fx });
      continue;
    }
    const q = await market.quote(position.data_symbol ?? position.ticker);
    const fx = q ? await toBase(market, q.currency) : null;
    const costFx = q && position.currency !== q.currency ? await toBase(market, position.currency) : fx;
    if (!q || !fx || !costFx) { missing.push(position.ticker); continue; }
    // Quote currency can differ from the cost currency (e.g. pence); value in the quote's own terms.
    holdings.push({ position, price_local: q.price, base_per_local: fx, base_per_cost: costFx, value: position.shares * q.price * fx });
  }
  return { holdings, missing };
}

export async function buildProposal(newCash: number, market: MarketData = yahoo): Promise<{ proposal: Proposal; missing: string[]; incomeCash: number } | null> {
  const targets = loadTargets();
  if (Object.keys(targets.targets).length === 0) return null;
  if (targets.mode === 'region' || targets.mode === 'sector') await classifyHoldings(market);
  const { holdings, missing } = await valueHoldings(market);
  const profile = incomeStore.tax();
  const ledger = incomeStore.ledger();
  // Upcoming income meant for reinvest/repurpose in the next 30 days counts as cash to place.
  const soon = Date.now() + 30 * 86_400_000;
  const plan = incomeStore.plan();
  const incomeCash = incomeStore.calendar().events
    .filter((e) => e.status !== 'paid' && e.status !== 'skipped' && Date.parse(e.payDate) <= soon)
    .reduce((s, e) => s + e.tax.net * planFor(plan, e.ticker).parts
      .filter((x) => x.action === 'reinvest' || x.action === 'repurpose').reduce((a, x) => a + x.pct, 0) / 100, 0);
  const proposal = proposeRebalance({
    holdings, reserve: ledger.reserve, targets, newCash: newCash + incomeCash, profile,
    allowanceLeft: (account) => allowanceLeft(profile, ledger, account),
    basePerAllowanceUnit: await basePerAllowanceUnit(profile, market),
  });
  return { proposal, missing, incomeCash };
}

export function describeProposal(r: { proposal: Proposal; missing: string[]; incomeCash: number }, band: number): string {
  const { proposal: p } = r;
  const lines = [`Portfolio ${money(p.total)} · band ±${band} points`];
  const hasAfter = p.trades.length > 0;
  for (const d of p.drifts) {
    const after = hasAfter && d.after_pct != null ? ` → ${d.after_pct.toFixed(1)} %` : '';
    lines.push(`${d.outside_band ? '!' : ' '} ${d.key.padEnd(14)} ${d.weight_pct.toFixed(1).padStart(5)} %${after} (target ${d.target_pct} %, ${d.drift_pct >= 0 ? '+' : ''}${d.drift_pct.toFixed(1)})`);
  }
  if (hasAfter) {
    lines.push('', 'Suggested (Rubo does not trade):');
    for (const t of p.trades) {
      const fee = t.est_fee ? ` · fee ${money(t.est_fee)}` : '';
      lines.push(t.side === 'sell'
        ? `  sell ${t.shares} ${t.ticker} ≈ ${money(t.amount)}${t.est_tax ? ` · est. tax ${money(t.est_tax)}${t.cost_basis === 'fifo' ? ' (oldest shares first)' : ''}` : ''}${fee}`
        : `  buy  ${t.key} for ${money(t.amount)} (from ${t.funded_by})${fee}`);
    }
    if (p.est_tax) lines.push(`Estimated tax on the sales: ${money(p.est_tax)}`);
    if (p.est_fees) lines.push(`Estimated fees: ${money(p.est_fees)}`);
  }
  if (r.incomeCash > 0) lines.push(`Includes ${money(r.incomeCash)} of income due in 30 days that your plan reinvests.`);
  if (r.missing.length) lines.push(`No price for ${r.missing.join(', ')} - left out.`);
  if (p.notes.length) lines.push(...p.notes.map((n) => `Note: ${n}.`));
  return lines.join('\n');
}

const MODE_LABEL: Record<TargetMode, string> = { holding: 'per holding', asset_type: 'per asset type', region: 'per region', sector: 'per sector' };
const MODES = Object.keys(MODE_LABEL) as TargetMode[];
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

const REGIONS: Record<string, string[]> = {
  north_america: ['United States', 'Canada'],
  europe: ['Germany', 'France', 'Netherlands', 'Switzerland', 'United Kingdom', 'Ireland', 'Italy', 'Spain', 'Sweden', 'Denmark',
    'Norway', 'Finland', 'Belgium', 'Austria', 'Portugal', 'Luxembourg', 'Poland', 'Jersey', 'Guernsey', 'Isle of Man'],
  asia_pacific: ['Japan', 'China', 'Hong Kong', 'Taiwan', 'South Korea', 'Australia', 'Singapore', 'India', 'New Zealand'],
};
export const regionOf = (country: string) => Object.entries(REGIONS).find(([, cs]) => cs.includes(country))?.[0] ?? 'other';

/**
 * Region and sector for holdings that have neither, from Yahoo's company
 * profile, saved on the position so it is looked up once. Funds have no single
 * sector or region; the owner tags them (/targets tag VT region world).
 */
export async function classifyHoldings(market: MarketData): Promise<void> {
  if (!market.profile) return;
  const store = new PortfolioStore();
  const found = new Map<string, { region?: string; sector?: string }>();
  for (const p of store.read().positions) {
    if (p.asset_type === 'etf' || p.asset_type === 'cash' || p.asset_type === 'bond' || (p.region && p.sector)) continue;
    const prof = await market.profile(p.data_symbol ?? p.ticker);
    if (prof) found.set(p.ticker, { region: prof.country ? regionOf(prof.country) : undefined, sector: prof.sector ? key(prof.sector) : undefined });
  }
  if (found.size === 0) return;
  store.update((pf) => ({
    ...pf,
    positions: pf.positions.map((p) => {
      const f = found.get(p.ticker);
      return f ? { ...p, region: p.region ?? f.region, sector: p.sector ?? f.sector } : p;
    }),
  }));
}

const TARGETS_HELP = [
  'Use /targets, or:',
  '  /targets set stock 50 etf 40 cash 10     (weights for the current mode, adding up to 100)',
  '  /targets mode holding|asset_type|region|sector',
  '  /targets tag VT region world             (a holding\'s region or sector, e.g. for funds)',
  '  /targets band 5 · /targets min 100 · /targets fee 1 0.1   (fixed fee, then % of the trade)',
].join('\n');

/** /targets and /rebalance, shared by the CLI and Telegram. */
export async function runRebalanceCommand(command: 'targets' | 'rebalance', args: string, market: MarketData = yahoo): Promise<string> {
  const t = loadTargets();
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (command === 'rebalance') {
    const cashIdx = words.indexOf('cash');
    const cash = cashIdx >= 0 ? Number(words[cashIdx + 1]) || 0 : 0;
    const r = await buildProposal(cash, market);
    return r ? describeProposal(r, t.band_pct) : 'No targets yet. Example: /targets set stock 50 etf 40 cash 10';
  }
  const [verb = 'show', ...rest] = words;
  const num = (w: string | undefined) => Number((w ?? '').replace('%', ''));
  if (verb === 'mode' && MODES.includes(rest[0] as TargetMode)) {
    t.mode = rest[0] as TargetMode;
    t.targets = {};
    if (t.mode === 'region' || t.mode === 'sector') await classifyHoldings(market);
  } else if (verb === 'band' && num(rest[0]) > 0) t.band_pct = num(rest[0]);
  else if (verb === 'min' && num(rest[0]) >= 0) t.min_trade = num(rest[0]);
  else if (verb === 'fee' && num(rest[0]) >= 0) {
    t.fee_fixed = num(rest[0]);
    t.fee_pct = rest[1] != null && num(rest[1]) >= 0 ? num(rest[1]) : 0;
  } else if (verb === 'tag' && rest.length >= 3 && (rest[1] === 'region' || rest[1] === 'sector')) {
    const [ref, field, ...name] = rest;
    const store = new PortfolioStore();
    // The ticker, the same without its exchange suffix (VGWD for VGWD.DE), the data symbol or the ISIN.
    const r = ref!.toUpperCase();
    const matches = (p: Position) => [p.ticker, p.ticker.split('.')[0], p.data_symbol?.toUpperCase(), p.isin].includes(r);
    const hit = store.read().positions.filter(matches);
    if (hit.length === 0) return `${ref} is not held.`;
    store.update((pf) => ({ ...pf, positions: pf.positions.map((p) => (matches(p) ? { ...p, [field!]: key(name.join(' ')) } : p)) }));
    return `${hit.map((p) => p.ticker).join(', ')}: ${field} ${key(name.join(' '))}`;
  } else if (verb === 'clear') t.targets = {};
  else if (verb === 'set') {
    const next: Record<string, number> = {};
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const k = t.mode === 'holding' ? rest[i]!.toUpperCase() : key(rest[i]!);
      const v = num(rest[i + 1]);
      if (!Number.isFinite(v) || v < 0) return `Not saved: "${rest[i + 1]}" is not a percentage.`;
      next[k] = v;
    }
    const sum = Object.values(next).reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 100) > 0.01) return `Not saved: targets add up to ${sum} %, not 100 %.`;
    t.targets = next;
  } else if (verb !== 'show') return TARGETS_HELP;
  if (verb !== 'show') saveTargets(t);

  const list = Object.entries(t.targets).map(([k, v]) => `${k} ${v} %`).join(', ') || 'none';
  const lines = [
    `Targets (${MODE_LABEL[t.mode]}): ${list} · band ±${t.band_pct} points`,
    `Smallest trade ${money(t.min_trade)} · fees ${money(t.fee_fixed ?? 0)} + ${t.fee_pct ?? 0} % per trade`,
  ];
  if (t.mode === 'region' || t.mode === 'sector') {
    const positions = new PortfolioStore().read().positions;
    const groups = new Map<string, string[]>();
    for (const p of positions) groups.set(bucketOf(t, p), [...(groups.get(bucketOf(t, p)) ?? []), p.ticker]);
    lines.push(...[...groups].map(([g, ts]) => `  ${g}: ${ts.join(', ')}`));
  }
  lines.push('/rebalance shows what it would take.');
  return lines.join('\n');
}

/** Quarterly cron: only speaks when something is outside its band. */
export async function rebalanceCheckMessage(market: MarketData = yahoo): Promise<string> {
  const r = await buildProposal(0, market);
  if (!r || !r.proposal.drifts.some((d) => d.outside_band)) return '';
  return `⚖️ Quarterly check: your portfolio has drifted.\n\n${describeProposal(r, loadTargets().band_pct)}`;
}

export function ensureRebalanceCheckJob(): void {
  const store = loadCronStore();
  const name = 'rebalance:check';
  if (store.jobs.some((j) => j.name === name)) return;
  const now = Date.now();
  const tz = timeZone();
  const schedule = { kind: 'cron' as const, expr: '0 9 1 1,4,7,10 *', tz };
  store.jobs.push({
    id: randomBytes(8).toString('hex'), name, description: 'Quarterly: alert when holdings drift outside their target band',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule, payload: { message: '', handler: 'rebalance_check' },
    fulfillment: 'keep', state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
  });
  saveCronStore(store);
}
