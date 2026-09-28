/**
 * Broker exports → normalised holdings. No network: text in, rows out,
 * so every format is testable from a fixture.
 */
import { baseCurrency } from '../utils/locale.js';

export interface ImportedHolding {
  isin?: string;
  symbol?: string;
  name?: string;
  shares: number;
  avg_cost: number;
  currency: string;
  asset_type?: 'stock' | 'etf' | 'bond';
}

export interface ParseResult {
  format: string;
  holdings: ImportedHolding[];
  warnings: string[];
}

/** CSV with quotes; delimiter detected from the first lines (, ; or tab). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^﻿/, '');
  const sample = clean.split(/\r?\n/).slice(0, 5).join('\n');
  const delim = [';', '\t', ','].reduce((best, d) => (count(sample, d) > count(sample, best) ? d : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]!;
    if (quoted) {
      if (ch === '"' && clean[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(cell.trim()); cell = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** "1.234,56" (German), "1,234.56" (English), "-12" → number; NaN if not a number. */
export function parseNumber(raw: string | undefined): number {
  if (raw == null) return NaN;
  let s = raw.replace(/[\s€$£%]/g, '').replace(/[A-Z]{3}$/i, '');
  if (!s) return NaN;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return Number(s);
}

const key = (h: string) => h.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

/** Column synonyms across brokers and languages (keys already normalised). */
const COLUMNS: Record<string, string[]> = {
  isin: ['isin', 'securityid'],
  symbol: ['symbol', 'ticker'],
  name: ['name', 'bezeichnung', 'description', 'wertpapier', 'instrument', 'titel', 'wertpapiername'],
  shares: ['shares', 'quantity', 'qty', 'stuck', 'stueck', 'anzahl', 'position', 'menge', 'units', 'stk', 'bestand'],
  avg_cost: ['avgcost', 'averagecost', 'costprice', 'costbasisprice', 'einstandskurs', 'kaufkurs', 'durchschnittskurs', 'einstandspreis', 'avgprice', 'averageprice', 'price', 'preis', 'kurs'],
  currency: ['currency', 'currencyprimary', 'wahrung', 'waehrung', 'ccy'],
  type: ['assetclass', 'assetcategory', 'type', 'art', 'wertpapierart', 'typ', 'transactiontype', 'transaktion'],
  amount: ['amount', 'betrag', 'value', 'wert'],
};

function findColumns(header: string[]): Record<string, number> {
  const norm = header.map(key);
  const out: Record<string, number> = {};
  for (const [field, names] of Object.entries(COLUMNS)) {
    const idx = norm.findIndex((h) => names.includes(h));
    if (idx >= 0) out[field] = idx;
  }
  return out;
}

function assetType(raw: string | undefined): ImportedHolding['asset_type'] {
  const t = (raw ?? '').toLowerCase();
  if (/etf|fund|fonds/.test(t)) return 'etf';
  if (/bond|anleihe|rente/.test(t)) return 'bond';
  if (/stock|aktie|equity|common|stk/.test(t)) return 'stock';
  return undefined;
}

/**
 * IBKR Activity Statement CSV: every line is `Section,Header|Data|Total,...`.
 * Holdings come from "Open Positions" (Summary rows), ISIN and instrument type
 * from "Financial Instrument Information", joined on the symbol.
 */
export function parseIbkrStatement(rows: string[][]): ParseResult | null {
  const sections = new Map<string, { header: string[]; data: string[][] }>();
  for (const r of rows) {
    const [section, kind] = r;
    if (!section || !kind) continue;
    if (kind === 'Header') sections.set(section, { header: r.slice(2), data: sections.get(section)?.data ?? [] });
    else if (kind === 'Data') sections.get(section)?.data.push(r.slice(2));
  }
  const open = sections.get('Open Positions');
  if (!open) return null;
  const col = (h: string[], name: string) => h.findIndex((x) => x === name);
  const info = new Map<string, { isin?: string; name?: string; type?: string }>();
  const fin = sections.get('Financial Instrument Information');
  if (fin) {
    const [iSym, iIsin, iDesc, iType] = ['Symbol', 'Security ID', 'Description', 'Type'].map((n) => col(fin.header, n));
    for (const d of fin.data) info.set(d[iSym!]!, { isin: d[iIsin!], name: d[iDesc!], type: d[iType!] });
  }
  const h = open.header;
  const [iDisc, iCat, iCur, iSym, iQty, iCost] = ['DataDiscriminator', 'Asset Category', 'Currency', 'Symbol', 'Quantity', 'Cost Price'].map((n) => col(h, n));
  const warnings: string[] = [];
  const holdings: ImportedHolding[] = [];
  for (const d of open.data) {
    if (iDisc! >= 0 && d[iDisc!] && d[iDisc!] !== 'Summary') continue;
    const category = d[iCat!] ?? '';
    if (/forex|cash/i.test(category)) continue;
    const symbol = d[iSym!]!;
    const meta = info.get(symbol) ?? {};
    const shares = parseNumber(d[iQty!]);
    const cost = parseNumber(d[iCost!]);
    if (!Number.isFinite(shares) || !Number.isFinite(cost)) { warnings.push(`skipped ${symbol}: unreadable quantity or cost`); continue; }
    holdings.push({
      symbol, isin: meta.isin || undefined, name: meta.name, shares, avg_cost: cost, currency: d[iCur!] ?? 'USD',
      asset_type: assetType(meta.type) ?? (/bond/i.test(category) ? 'bond' : 'stock'),
    });
  }
  return { format: 'IBKR Activity Statement', holdings, warnings };
}

const BUY = /^(buy|kauf|sparplan|savings ?plan|purchase|einbuchung|bonus|reinvest)/i;
const SELL = /^(sell|verkauf|ausbuchung|sale)/i;

/**
 * Any table with recognisable columns: a holdings list (one row per position)
 * or a transaction list (buys/sells, aggregated into holdings with an average
 * cost). Covers Trade Republic exports and IBKR Flex queries.
 */
export function parseGenericTable(rows: string[][], format: string): ParseResult | null {
  const headerIdx = rows.findIndex((r) => {
    const c = findColumns(r);
    return c.shares != null && (c.isin != null || c.symbol != null);
  });
  if (headerIdx < 0) return null;
  const c = findColumns(rows[headerIdx]!);
  const data = rows.slice(headerIdx + 1);
  const warnings: string[] = [];
  const typeValues = c.type != null ? data.map((r) => r[c.type!] ?? '') : [];
  const isTransactions = typeValues.some((t) => BUY.test(t) || SELL.test(t));

  const byKey = new Map<string, ImportedHolding & { cost_total: number }>();
  for (const r of data) {
    const isin = c.isin != null ? r[c.isin]?.toUpperCase() : undefined;
    const symbol = c.symbol != null ? r[c.symbol] : undefined;
    const id = isin || symbol;
    if (!id) continue;
    const shares = Math.abs(parseNumber(r[c.shares!]));
    let price = c.avg_cost != null ? parseNumber(r[c.avg_cost]) : NaN;
    if (!Number.isFinite(price) && c.amount != null && shares) price = Math.abs(parseNumber(r[c.amount])) / shares;
    if (!Number.isFinite(shares) || shares === 0) continue;
    const type = c.type != null ? r[c.type] ?? '' : '';
    const sign = isTransactions ? (BUY.test(type) ? 1 : SELL.test(type) ? -1 : 0) : 1;
    if (sign === 0) continue; // dividends, fees, deposits in a transaction list
    const h = byKey.get(id) ?? {
      isin, symbol, name: c.name != null ? r[c.name] : undefined, shares: 0, avg_cost: 0, cost_total: 0,
      currency: (c.currency != null ? r[c.currency] : '') || baseCurrency(), asset_type: assetType(isTransactions ? undefined : type),
    };
    if (sign > 0) {
      if (!Number.isFinite(price)) warnings.push(`${id}: a buy without a price; average cost may be off`);
      h.cost_total += shares * (Number.isFinite(price) ? price : 0);
      h.shares += shares;
    } else {
      // Average-cost method: a sale removes shares at the current average.
      const avg = h.shares ? h.cost_total / h.shares : 0;
      h.shares -= shares;
      h.cost_total -= avg * shares;
    }
    byKey.set(id, h);
  }
  const holdings = [...byKey.values()]
    .filter((h) => h.shares > 1e-9)
    .map(({ cost_total, ...h }) => ({ ...h, shares: Math.round(h.shares * 1e6) / 1e6, avg_cost: Math.round((cost_total / h.shares) * 1e4) / 1e4 }));
  return { format: isTransactions ? `${format} (transactions → holdings)` : format, holdings, warnings };
}

export function parseBrokerExport(text: string, broker?: string): ParseResult {
  const rows = parseCsv(text);
  const ibkr = parseIbkrStatement(rows);
  if (ibkr && ibkr.holdings.length) return ibkr;
  const generic = parseGenericTable(rows, broker === 'ibkr' ? 'IBKR Flex query' : broker === 'traderepublic' ? 'Trade Republic export' : 'CSV');
  if (generic) return generic;
  return { format: 'unknown', holdings: [], warnings: ['No ISIN/symbol and quantity columns found. Export holdings or transactions as CSV.'] };
}
