import { ensureAccounts } from '../income/store.js';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { yahoo, type IsinMatch, type MarketData } from '../market/yahoo.js';
import { PortfolioStore, type Position } from '../tools/portfolio/store.js';
import { ruboPath } from '../utils/paths.js';
import { parseBrokerExport, type ImportedHolding } from './parse.js';

/**
 * Import = preview, then confirm. The preview is stored so `/import confirm`
 * applies exactly what the owner saw, from the CLI or Telegram.
 */
export interface ImportChange {
  kind: 'add' | 'update' | 'unchanged';
  position: Position;
  before?: Pick<Position, 'shares' | 'avg_cost'>;
}

export interface ImportPreview {
  account: string;
  format: string;
  changes: ImportChange[];
  /** Held in this account before, absent from the export: kept, listed for the owner. */
  missing: string[];
  unresolved: string[];
  warnings: string[];
  created_at: string;
}

const pendingPath = () => ruboPath('import', 'pending.json');

const PREFERRED_EXCHANGES: Record<string, string[]> = {
  EUR: ['GER', 'FRA', 'AMS', 'PAR', 'MIL', 'STU', 'MUN'],
  USD: ['NYQ', 'NMS', 'NGM', 'NCM', 'PCX', 'ASE', 'BTS'],
  GBP: ['LSE'],
  GBp: ['LSE'],
  CHF: ['EBS'],
};

/** ISO code, except London pence (GBp/GBX), which must stay distinct from pounds. */
const currencyCode = (c: string) => (c === 'GBp' || c.toUpperCase() === 'GBX' ? 'GBp' : c.toUpperCase());

/**
 * Listings in the order to try: equities/ETFs, on an exchange that trades in the
 * holding's currency first (Xetra before Frankfurt, NYSE before the rest), and
 * Yahoo's own matches before ones built from OpenFIGI at the same rank.
 */
export function rankListings(matches: IsinMatch[], currency: string): IsinMatch[] {
  const usable = matches.filter((m) => m.quoteType === 'EQUITY' || m.quoteType === 'ETF');
  const pool = usable.length ? usable : matches;
  const prefs = PREFERRED_EXCHANGES[currency] ?? [];
  const rank = (m: IsinMatch) => {
    const i = prefs.indexOf(m.exchange);
    return (i < 0 ? prefs.length : i) * 2 + (m.unverified ? 1 : 0);
  };
  return pool.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i).map(({ m }) => m);
}

export function pickListing(matches: IsinMatch[], currency: string): IsinMatch | undefined {
  return rankListings(matches, currency)[0];
}

/** The best listing that really trades: unverified candidates must return a Yahoo quote. */
async function resolveListing(matches: IsinMatch[], currency: string, market: MarketData): Promise<IsinMatch | undefined> {
  let tries = 0;
  for (const m of rankListings(matches, currency)) {
    if (!m.unverified) return m;
    if (++tries > 6) break;
    if (await market.quote(m.symbol)) return m;
  }
  return undefined;
}

async function toPosition(h: ImportedHolding, account: string, market: MarketData, today: string): Promise<Position | null> {
  let dataSymbol = h.symbol;
  let type = h.asset_type;
  if (h.isin) {
    const matches = await market.searchIsin(h.isin);
    // A symbol the export itself names wins when it is one of the listings.
    const named = h.symbol ? matches.find((m) => m.symbol.toUpperCase() === h.symbol!.toUpperCase()) : undefined;
    const match = named ?? (await resolveListing(matches, currencyCode(h.currency), market));
    if (match) {
      dataSymbol = match.symbol;
      type ??= match.quoteType === 'ETF' ? 'etf' : 'stock';
    }
  }
  if (!dataSymbol) return null;
  return {
    ticker: (h.symbol ?? dataSymbol).toUpperCase(),
    data_symbol: dataSymbol,
    shares: h.shares,
    avg_cost: h.avg_cost,
    currency: currencyCode(h.currency),
    opened: today,
    thesis: `Imported from ${account} on ${today}`,
    conviction: 'med',
    asset_type: type ?? 'stock',
    isin: h.isin,
    name: h.name,
    account,
  };
}

export async function previewImport(text: string, account: string, market: MarketData = yahoo): Promise<ImportPreview> {
  const parsed = parseBrokerExport(text, account);
  const today = new Date().toISOString().slice(0, 10);
  const current = new PortfolioStore().read().positions;
  const sameAccount = current.filter((p) => (p.account ?? account) === account);
  const changes: ImportChange[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>();

  for (const h of parsed.holdings) {
    const pos = await toPosition(h, account, market, today);
    if (!pos) { unresolved.push(h.isin ?? h.name ?? '?'); continue; }
    const existing = sameAccount.find((p) => (pos.isin && p.isin === pos.isin) || p.ticker === pos.ticker);
    if (existing) {
      seen.add(existing.ticker);
      const same = Math.abs(existing.shares - pos.shares) < 1e-6 && Math.abs(existing.avg_cost - pos.avg_cost) < 1e-4;
      // Keep what the owner wrote (thesis, conviction, targets, opened); refresh what the broker knows.
      changes.push({
        kind: same ? 'unchanged' : 'update',
        before: { shares: existing.shares, avg_cost: existing.avg_cost },
        position: { ...existing, shares: pos.shares, avg_cost: pos.avg_cost, currency: pos.currency, isin: pos.isin ?? existing.isin,
          name: pos.name ?? existing.name, asset_type: existing.asset_type ?? pos.asset_type, data_symbol: existing.data_symbol ?? pos.data_symbol, account },
      });
    } else {
      changes.push({ kind: 'add', position: pos });
    }
  }
  const preview: ImportPreview = {
    account, format: parsed.format, changes,
    missing: sameAccount.filter((p) => !seen.has(p.ticker)).map((p) => p.ticker),
    unresolved, warnings: parsed.warnings, created_at: new Date().toISOString(),
  };
  mkdirSync(dirname(pendingPath()), { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify(preview, null, 2), 'utf8');
  return preview;
}

export function describePreview(p: ImportPreview): string {
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(4));
  const lines = [`${p.format} → account "${p.account}"`];
  const add = p.changes.filter((c) => c.kind === 'add');
  const upd = p.changes.filter((c) => c.kind === 'update');
  for (const c of add) lines.push(`+ ${c.position.ticker} (${c.position.asset_type}) ${fmt(c.position.shares)} @ ${c.position.avg_cost} ${c.position.currency}${c.position.isin ? `  ${c.position.isin}` : ''}`);
  for (const c of upd) lines.push(`~ ${c.position.ticker} ${fmt(c.before!.shares)} → ${fmt(c.position.shares)} @ ${c.position.avg_cost} ${c.position.currency}`);
  const same = p.changes.length - add.length - upd.length;
  if (same) lines.push(`= ${same} unchanged`);
  if (p.missing.length) lines.push(`Not in this export (kept - close them if sold): ${p.missing.join(', ')}`);
  if (p.unresolved.length) lines.push(`Could not identify (not imported): ${p.unresolved.join(', ')}`);
  if (p.warnings.length) lines.push(`Warnings: ${p.warnings.join('; ')}`);
  lines.push('', add.length || upd.length ? 'Nothing is saved yet. /import confirm to apply, /import cancel to discard.' : 'Nothing to change.');
  return lines.join('\n');
}

export function confirmImport(): string {
  if (!existsSync(pendingPath())) return 'No import waiting. Send or name an export file first.';
  const p = JSON.parse(readFileSync(pendingPath(), 'utf8')) as ImportPreview;
  const store = new PortfolioStore();
  store.update((portfolio) => {
    let positions = [...portfolio.positions];
    for (const c of p.changes) {
      if (c.kind === 'unchanged') continue;
      const i = positions.findIndex((x) => x.ticker === c.position.ticker && (x.account ?? p.account) === p.account);
      if (i >= 0) positions[i] = c.position;
      else positions = [...positions, c.position];
    }
    const journal = [{ date: new Date().toISOString().slice(0, 10), text: `Imported ${p.format} into ${p.account}: ${p.changes.filter((c) => c.kind !== 'unchanged').length} changes.`, category: 'trade' as const }, ...portfolio.journal];
    return { ...portfolio, positions, journal };
  });
  rmSync(pendingPath());
  const added = ensureAccounts([p.account]);
  const n = p.changes.filter((c) => c.kind !== 'unchanged').length;
  const lines = [`Imported ${n} change${n === 1 ? '' : 's'} into ${p.account}. /income shows the payments they will bring.`];
  if (added.length) lines.push(`New account ${added.join(', ')}: check its tax settings with /tax (W-8BEN, whether it withholds your tax).`);
  return lines.join('\n');
}

export function cancelImport(): string {
  if (!existsSync(pendingPath())) return 'No import waiting.';
  rmSync(pendingPath());
  return 'Import discarded.';
}
