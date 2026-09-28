import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { INCOME_COMMANDS, runIncomeCommand, type IncomeCommand } from '../income/commands.js';
import { cancelImport, confirmImport, describePreview, previewImport } from '../importer/apply.js';
import { runRebalanceCommand } from '../rebalance/check.js';
import { accountId, BROKERS } from '../income/brokers.js';
import { describePlan } from '../income/plan.js';
import { convertRecorded, incomeStore } from '../income/store.js';
import { loadTargets, saveTargets } from '../rebalance/check.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { setSetting } from '../utils/config.js';
import { baseCurrency, money, timeZone } from '../utils/locale.js';
import { yahoo, type MarketData } from '../market/yahoo.js';

/**
 * Money commands answered by code, not the model, identically in the CLI and
 * on Telegram. Returns the reply, or null when `name` is not one of them.
 */
export const FINANCE_COMMANDS = [...INCOME_COMMANDS, 'import', 'targets', 'rebalance', 'setup'] as const;

/**
 * Which account an export belongs to: a broker named in the hint or file name,
 * an IBKR statement recognised from its layout, a one-word hint used as the
 * account name, else "default".
 */
export function detectAccount(hint: string, fileName: string, text: string): string {
  const words = `${hint} ${fileName.replace(/\.[^.]+$/, '')}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const squashed = words.join('');
  // Short names (ING, DKB) only as whole words, so "holdings.csv" is not ING.
  const named = (s: string) => words.includes(s) || (s.length >= 6 && squashed.includes(s));
  const known = Object.entries(BROKERS).find(([id, b]) => named(id) || named(b.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
  if (known) return known[0];
  if (words.some((w) => ['ibkr', 'ib', 'tr'].includes(w))) return accountId(words.find((w) => ['ibkr', 'ib', 'tr'].includes(w))!);
  if (/^Statement,|Open Positions,Header/m.test(text) || words.some((w) => /^u\d{6,}$/.test(w))) return 'ibkr';
  const single = hint.trim().split(/\s+/).filter(Boolean);
  return single.length === 1 ? accountId(single[0]!) : 'default';
}

export async function importFromText(text: string, fileName: string, hint = ''): Promise<string> {
  const account = detectAccount(hint, fileName, text);
  return describePreview(await previewImport(text, account));
}

export async function runFinanceCommand(name: string, args: string, market: MarketData = yahoo): Promise<string | null> {
  if ((INCOME_COMMANDS as readonly string[]).includes(name)) return runIncomeCommand(name as IncomeCommand, args, market);
  if (name === 'targets' || name === 'rebalance') return runRebalanceCommand(name, args, market);
  if (name === 'setup') return setup(args, market);
  if (name === 'import') {
    const [first = '', ...rest] = args.trim().split(/\s+/);
    if (first === 'confirm') return confirmImport();
    if (first === 'cancel') return cancelImport();
    if (!first) return 'Import a broker export: /import <path to CSV> [account name, e.g. ibkr or degiro] - or send the CSV to the Telegram bot.';
    const path = first.replace(/^["']|["']$/g, '');
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch { return `Cannot read "${path}".`; }
    return importFromText(text, basename(path), rest.join(' '));
  }
  return null;
}

/** /setup: the owner's own settings, as a checklist. Everything else is changed where it lives (/tax, /yieldplan, /targets). */
async function setup(args: string, market: MarketData = yahoo): Promise<string> {
  const [key = '', value = ''] = args.trim().split(/\s+/);
  if (key === 'currency') {
    if (!/^[a-z]{3}$/i.test(value)) return 'Currency is a three-letter code, e.g. /setup currency EUR.';
    const before = baseCurrency();
    const after = value.toUpperCase();
    if (before !== after) {
      // Everything recorded in the old currency is converted at today's rate, so
      // the reserve, confirmed payments and minimum trade keep their value.
      const rate = await market.rate(before, after);
      if (!rate) return `No ${before}→${after} exchange rate available right now, so nothing was changed. Try again later.`;
      const converted = convertRecorded(rate);
      const targets = loadTargets();
      targets.min_trade = Math.round(targets.min_trade * rate * 100) / 100;
      saveTargets(targets);
      setSetting('base_currency', after);
      const note = converted || incomeStore.ledger().reserve
        ? `Converted what was recorded at 1 ${before} = ${rate.toFixed(4)} ${after}: reserve now ${money(incomeStore.ledger().reserve)}, ${converted} payments.`
        : '';
      return [`Base currency is now ${after}.`, note, '', await setup('', market)].filter((l, i) => l || i === 2).join('\n');
    }
  } else if (key === 'timezone') {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); }
    catch { return `"${value}" is not a time zone. Use an IANA name, e.g. /setup timezone Europe/Paris.`; }
    setSetting('timezone', value);
  } else if (key) return 'Use /setup, /setup currency <code> or /setup timezone <Area/City>.';

  const tax = incomeStore.tax();
  const accounts = Object.keys(tax.accounts);
  const positions = new PortfolioStore().read().positions.length;
  const plan = incomeStore.plan();
  const targets = loadTargets();
  const row = (ok: boolean, text: string, how: string) => `${ok ? '✓' : '○'} ${text}${ok ? '' : `  →  ${how}`}`;
  return [
    'Your setup:',
    row(true, `Base currency: ${baseCurrency()}`, ''),
    row(true, `Time zone: ${timeZone()} (reminders and session ids)`, ''),
    row(positions > 0, `Holdings: ${positions}`, '/import <broker CSV> (or send it to the Telegram bot)'),
    row(Boolean(tax.residence), `Tax residence: ${tax.residence ?? 'not set'}`, '/tax set residence XX'),
    row(accounts.length > 0 && Boolean(tax.confirmed_at), `Accounts: ${accounts.join(', ') || 'none'}${tax.confirmed_at ? '' : ' (tax settings not confirmed)'}`, '/tax, then /tax confirm'),
    row(Boolean(plan.updated_at), `Income plan: ${describePlan(plan.default)}${plan.updated_at ? '' : ' (starting default)'}`, '/yieldplan set …'),
    row(Object.keys(targets.targets).length > 0, `Rebalancing targets: ${Object.entries(targets.targets).map(([k, v]) => `${k} ${v} %`).join(', ') || 'none'}`, '/targets set stock 60 etf 30 cash 10'),
    '',
    'Change: /setup currency EUR · /setup timezone Europe/Paris',
  ].join('\n');
}
