import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { yahoo, type MarketData } from '../market/yahoo.js';
import { computeNextRunAtMs } from '../cron/schedule.js';
import { loadCronStore, saveCronStore } from '../cron/store.js';
import { allowanceLeftEur, incomeStore } from '../income/store.js';
import { planFor } from '../income/plan.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { getSetting } from '../utils/config.js';
import { ruboPath } from '../utils/paths.js';
import { DEFAULT_TARGETS, proposeRebalance, type Proposal, type Targets, type ValuedHolding } from './engine.js';

const targetsPath = () => ruboPath('rebalance', 'targets.json');
const usd = (n: number) => `$${n.toFixed(2)}`;

export function loadTargets(): Targets {
  if (!existsSync(targetsPath())) return structuredClone(DEFAULT_TARGETS);
  try { return { ...structuredClone(DEFAULT_TARGETS), ...JSON.parse(readFileSync(targetsPath(), 'utf8')) }; }
  catch { return structuredClone(DEFAULT_TARGETS); }
}

export function saveTargets(t: Targets): void {
  mkdirSync(dirname(targetsPath()), { recursive: true });
  writeFileSync(targetsPath(), JSON.stringify({ ...t, updated_at: new Date().toISOString() }, null, 2), 'utf8');
}

export async function valueHoldings(market: MarketData): Promise<{ holdings: ValuedHolding[]; missing: string[] }> {
  const holdings: ValuedHolding[] = [];
  const missing: string[] = [];
  for (const position of new PortfolioStore().read().positions) {
    if (position.asset_type === 'cash') {
      const fx = await market.usdPerUnit(position.currency);
      if (fx) holdings.push({ position, price_local: 1, usd_per_local: fx, value_usd: position.shares * fx });
      continue;
    }
    const q = await market.quote(position.data_symbol ?? position.ticker);
    const fx = q ? await market.usdPerUnit(q.currency) : null;
    if (!q || !fx) { missing.push(position.ticker); continue; }
    // Quote currency can differ from the cost currency (e.g. pence); value in the quote's own terms.
    holdings.push({ position, price_local: q.price, usd_per_local: fx, value_usd: position.shares * q.price * fx });
  }
  return { holdings, missing };
}

export async function buildProposal(newCashUsd: number, market: MarketData = yahoo): Promise<{ proposal: Proposal; missing: string[]; incomeCash: number } | null> {
  const targets = loadTargets();
  if (Object.keys(targets.targets).length === 0) return null;
  const { holdings, missing } = await valueHoldings(market);
  const profile = incomeStore.tax();
  const ledger = incomeStore.ledger();
  // Upcoming income meant for reinvest/repurpose in the next 30 days counts as cash to place.
  const soon = Date.now() + 30 * 86_400_000;
  const plan = incomeStore.plan();
  const incomeCash = incomeStore.calendar().events
    .filter((e) => e.status !== 'paid' && e.status !== 'skipped' && Date.parse(e.payDate) <= soon)
    .reduce((s, e) => s + e.tax.net_usd * planFor(plan, e.ticker).parts
      .filter((x) => x.action === 'reinvest' || x.action === 'repurpose').reduce((a, x) => a + x.pct, 0) / 100, 0);
  const proposal = proposeRebalance({
    holdings, reserveUsd: ledger.reserve_usd, targets, newCashUsd: newCashUsd + incomeCash, profile,
    allowanceLeftEur: (account) => allowanceLeftEur(profile, ledger, account),
    usdPerEur: (await market.usdPerUnit('EUR')) ?? 1.1,
  });
  return { proposal, missing, incomeCash };
}

export function describeProposal(r: { proposal: Proposal; missing: string[]; incomeCash: number }, band: number): string {
  const { proposal: p } = r;
  const lines = [`Portfolio ${usd(p.total_usd)} · band ±${band} points`];
  for (const d of p.drifts) {
    lines.push(`${d.outside_band ? '!' : ' '} ${d.key.padEnd(10)} ${d.weight_pct.toFixed(1).padStart(5)} % (target ${d.target_pct} %, ${d.drift_pct >= 0 ? '+' : ''}${d.drift_pct.toFixed(1)})`);
  }
  if (p.trades.length) {
    lines.push('', 'Suggested (Rubo does not trade):');
    for (const t of p.trades) {
      lines.push(t.side === 'sell'
        ? `  sell ${t.shares} ${t.ticker} ≈ ${usd(t.usd)}${t.est_tax_usd ? ` · est. tax ${usd(t.est_tax_usd)}` : ''}`
        : `  buy  ${t.key} for ${usd(t.usd)} (from ${t.funded_by})`);
    }
    if (p.est_tax_usd) lines.push(`Estimated tax on the sales: ${usd(p.est_tax_usd)}`);
  }
  if (r.incomeCash > 0) lines.push(`Includes ${usd(r.incomeCash)} of income due in 30 days that your plan reinvests.`);
  if (r.missing.length) lines.push(`No price for ${r.missing.join(', ')} - left out.`);
  if (p.notes.length) lines.push(...p.notes.map((n) => `Note: ${n}.`));
  return lines.join('\n');
}

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
  if (verb === 'mode' && (rest[0] === 'holding' || rest[0] === 'asset_type')) { t.mode = rest[0]; t.targets = {}; }
  else if (verb === 'band' && Number(rest[0]) > 0) t.band_pct = Number(rest[0]);
  else if (verb === 'clear') t.targets = {};
  else if (verb === 'set') {
    const next: Record<string, number> = {};
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const k = t.mode === 'holding' ? rest[i]!.toUpperCase() : rest[i]!.toLowerCase();
      const v = Number(rest[i + 1]!.replace('%', ''));
      if (!Number.isFinite(v) || v < 0) return `Not saved: "${rest[i + 1]}" is not a percentage.`;
      next[k] = v;
    }
    const sum = Object.values(next).reduce((s, v) => s + v, 0);
    if (Math.abs(sum - 100) > 0.01) return `Not saved: targets add up to ${sum} %, not 100 %.`;
    t.targets = next;
  } else if (verb !== 'show') return 'Use /targets, /targets set stock 50 etf 40 cash 10, /targets mode holding|asset_type, /targets band 5.';
  if (verb !== 'show') saveTargets(t);
  const list = Object.entries(t.targets).map(([k, v]) => `${k} ${v} %`).join(', ') || 'none';
  return `Targets (${t.mode === 'holding' ? 'per holding' : 'per asset type'}): ${list} · band ±${t.band_pct} points\n/rebalance shows what it would take.`;
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
  const tz = getSetting<string>('timezone', process.env.RUBO_TIMEZONE || 'Europe/Berlin');
  const schedule = { kind: 'cron' as const, expr: '0 9 1 1,4,7,10 *', tz };
  store.jobs.push({
    id: randomBytes(8).toString('hex'), name, description: 'Quarterly: alert when holdings drift outside their target band',
    enabled: true, createdAtMs: now, updatedAtMs: now, schedule, payload: { message: '', handler: 'rebalance_check' },
    fulfillment: 'keep', state: { nextRunAtMs: computeNextRunAtMs(schedule, now), consecutiveErrors: 0, scheduleErrorCount: 0 },
  });
  saveCronStore(store);
}
