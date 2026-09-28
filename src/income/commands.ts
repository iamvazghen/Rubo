import { yahoo, type MarketData } from '../market/yahoo.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { formatShares } from './messages.js';
import { DEFAULT_YIELD_PLAN, describePlan, parsePlanSpec, planFor } from './plan.js';
import { planEvent, refreshIncome } from './refresh.js';
import { accountId, BROKERS, defaultAccountTax } from './brokers.js';
import { jurisdictionFor, JURISDICTIONS } from './jurisdictions.js';
import { allowanceLeft, basePerAllowanceUnit, incomeStore } from './store.js';
import { baseCurrency, money } from '../utils/locale.js';

/**
 * /income, /yieldplan, /tax, /reserve, /done - shared by the CLI and Telegram so
 * both answer identically. Each returns the text to show.
 */

export const INCOME_COMMANDS = ['income', 'yieldplan', 'tax', 'reserve', 'done'] as const;
export type IncomeCommand = (typeof INCOME_COMMANDS)[number];

export async function runIncomeCommand(command: IncomeCommand, args: string, market: MarketData = yahoo): Promise<string> {
  switch (command) {
    case 'income': return income(args, market);
    case 'yieldplan': return yieldPlan(args);
    case 'tax': return tax(args);
    case 'reserve': return reserve();
    case 'done': return done(args, market);
  }
}

async function income(args: string, market: MarketData): Promise<string> {
  if (args.trim() === 'refresh' || !incomeStore.calendar().refreshed_at) await refreshIncome({ market });
  const { events, refreshed_at } = incomeStore.calendar();
  const horizon = Date.now() + 90 * 86_400_000;
  const upcoming = events.filter((e) => (e.status === 'announced' || e.status === 'estimated') && Date.parse(e.payDate) <= horizon);
  if (upcoming.length === 0) {
    const held = new PortfolioStore().read().positions.length;
    return held === 0
      ? 'No holdings yet. Import them first: /import <broker export file>.'
      : 'No dividends, distributions or coupons expected in the next 90 days.';
  }
  const byMonth = new Map<string, number>();
  const rows = upcoming.map((e) => {
    byMonth.set(e.payDate.slice(0, 7), (byMonth.get(e.payDate.slice(0, 7)) ?? 0) + e.tax.net);
    const flag = e.status === 'estimated' ? ' est.' : '';
    return `${e.payDate}  ${e.ticker.padEnd(8)} ${money(e.gross).padStart(9)} gross  ${money(e.tax.net).padStart(9)} net${flag}   id ${e.id}`;
  });
  const months = [...byMonth].map(([m, v]) => `${m}: ${money(v)} net`).join('  ·  ');
  return [
    `Income, next 90 days (${baseCurrency()}):`, ...rows, '', months,
    `Calendar refreshed ${refreshed_at?.slice(0, 16).replace('T', ' ')} UTC · /income refresh to update`,
  ].join('\n');
}

function yieldPlan(args: string): string {
  const plan = incomeStore.plan();
  const [verb = 'show', ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (verb === 'show') {
    const lines = [`Default: ${describePlan(plan.default)}`];
    for (const [t, parts] of Object.entries(plan.overrides)) lines.push(`${t}: ${describePlan(parts)}`);
    if (!plan.updated_at) lines.push('', '(This is the starting default - change it any time.)');
    lines.push('', 'Change: /yieldplan set reinvest 40 reserve 30 withdraw 20 repurpose 10 VWCE',
      'One holding: /yieldplan set KO reinvest 100  ·  Remove it: /yieldplan reset KO');
    return lines.join('\n');
  }
  if (verb === 'reset') {
    const ticker = rest[0]?.toUpperCase();
    if (ticker) {
      delete plan.overrides[ticker];
      incomeStore.savePlan(plan);
      return `${ticker} now follows the default plan: ${describePlan(plan.default)}`;
    }
    incomeStore.savePlan({ ...DEFAULT_YIELD_PLAN });
    return `Plan reset to ${describePlan(DEFAULT_YIELD_PLAN.default)}`;
  }
  if (verb === 'set') {
    const first = rest[0] ?? '';
    const isAction = ['reinvest', 'reserve', 'withdraw', 'repurpose'].includes(first.toLowerCase());
    const ticker = isAction ? undefined : first.toUpperCase();
    const parsed = parsePlanSpec((isAction ? rest : rest.slice(1)).join(' '));
    if (typeof parsed === 'string') return `Not saved: ${parsed}.`;
    if (ticker) plan.overrides[ticker] = parsed;
    else plan.default = parsed;
    incomeStore.savePlan(plan);
    return `Saved${ticker ? ` for ${ticker}` : ''}: ${describePlan(parsed)}\nReminders pick it up at the next refresh (/income refresh to apply now).`;
  }
  return 'Use /yieldplan, /yieldplan set …, or /yieldplan reset [ticker].';
}

function tax(args: string): string {
  const t = incomeStore.tax();
  const [verb = 'show', key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  const value = rest.join(' ');
  const yes = /^(yes|true|1|on)$/i.test(value);
  if (verb === 'set' && key) {
    const acct = /^([\w-]+)\.(w8ben|domestic|allowance)$/.exec(key);
    if (key === 'residence') {
      t.residence = /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : null;
      if (value && !t.residence) return 'Residence is a two-letter country code, e.g. /tax set residence DE.';
      // A known broker is domestic exactly when it is in the new country; unknown ones keep what the owner set.
      for (const a of Object.values(t.accounts)) if (a.broker && BROKERS[a.broker]) a.domestic = BROKERS[a.broker]!.country === t.residence;
    } else if (key === 'filing' && (value === 'single' || value === 'joint')) t.filing = value;
    else if (acct) {
      const [, raw, field] = acct;
      const name = accountId(raw!);
      const a = (t.accounts[name] ??= defaultAccountTax(name, t.residence));
      if (field === 'w8ben') a.w8ben = yes;
      if (field === 'domestic') a.domestic = yes;
      if (field === 'allowance') a.allowance_assigned = Number(value) || 0;
    } else if (key === 'clear' && value) delete t.options[value];
    else if (/^[a-z_]+$/.test(key) && value !== '') {
      // Jurisdiction options (church_tax_rate) or own rules (flat_rate, allowance, credit_cap_rate, ...).
      const n = Number(value.replace('%', '')) / (value.endsWith('%') ? 100 : 1);
      if (!Number.isFinite(n)) return `${key} needs a number.`;
      t.options[key] = n;
    } else return `Unknown setting "${key}".`;
    t.confirmed_at = new Date().toISOString();
    incomeStore.saveTax(t);
  } else if (verb === 'confirm') {
    t.confirmed_at = new Date().toISOString();
    incomeStore.saveTax(t);
  }
  const j = jurisdictionFor(t.residence, t.options);
  const ledger = incomeStore.ledger();
  const allowanceMoney = (n: number) => (j && j.currency !== 'BASE' ? money(n, j.currency) : money(n));
  const options = Object.entries(t.options).map(([k, v]) => `${k} ${v}`).join(', ');
  const lines = [
    `Tax residence: ${t.residence ?? 'not set'}${j ? ` (${j.name})` : ''} · filing ${t.filing}${options ? ` · ${options}` : ''}`,
    j ? `Annual allowance: ${allowanceMoney(j.allowance(t.filing, t.options))}` :
      t.residence ? `No built-in rules for ${t.residence}: describe them with /tax set flat_rate 0.25 (and allowance, credit_cap_rate).` :
      'Only withholding at source is modelled until you /tax set residence XX.',
    ...Object.entries(t.accounts).map(([name, a]) => {
      const withholds = Boolean(a.domestic && j?.brokerWithholds);
      return `${name}${a.broker ? ` (${BROKERS[a.broker]?.name})` : ''}: ${withholds ? 'withholds your tax' : 'tax via your return'} · W-8BEN ${a.w8ben ? 'yes' : 'no'}` +
        `${withholds && j?.brokerAppliesAllowance ? ` · allowance assigned ${allowanceMoney(a.allowance_assigned)}` : ''}` +
        `${j ? ` · allowance left ${allowanceMoney(allowanceLeft(t, ledger, name))}` : ''}`;
    }),
  ];
  if (j && Object.keys(j.optionHelp).length) lines.push(...Object.entries(j.optionHelp).map(([k, v]) => `  ${k}: ${v}`));
  if (!t.confirmed_at) lines.push('', 'Nothing here is confirmed yet. Set what applies to you, then /tax confirm.');
  lines.push('', 'Change: /tax set residence DE · /tax set filing joint · /tax set <account>.w8ben yes · /tax set <account>.domestic yes · /tax set <account>.allowance 1000 · /tax set <option> <number> · /tax set clear <option>',
    `Built-in rules: ${Object.keys(JURISDICTIONS).join(', ')}; anywhere else: /tax set flat_rate <rate>.`);
  return lines.join('\n');
}

function reserve(): string {
  const l = incomeStore.ledger();
  const moves = l.entries.slice(-5).flatMap((e) =>
    e.allocations.filter((a) => a.action === 'reserve').map((a) => `  +${money(a.amount)} from ${e.ticker} (${e.confirmedAt.slice(0, 10)})`));
  return [`Cash reserve for down markets: ${money(l.reserve)}`, ...(moves.length ? ['Recent:', ...moves] : [])].join('\n');
}

async function done(args: string, market: MarketData): Promise<string> {
  const id = args.trim();
  const cal = incomeStore.calendar();
  const event = cal.events.find((e) => e.id === id) ?? cal.events.find((e) => e.ticker === id.toUpperCase() && e.status !== 'paid');
  if (!event) return `No payment "${id}". /income lists them with their ids.`;
  if (event.status === 'paid') return `${event.id} is already recorded.`;

  const { allocations } = await planEvent(event, market);
  const ledger = incomeStore.ledger();
  const perUnit = await basePerAllowanceUnit(incomeStore.tax(), market);
  const year = Number(event.payDate.slice(0, 4));
  const account = event.account ?? Object.keys(incomeStore.tax().accounts)[0] ?? 'default';
  const used = ledger.allowance_used[account];
  ledger.allowance_used[account] = {
    year, amount: (used?.year === year ? used.amount : 0) + event.tax.allowance_used / perUnit,
  };
  ledger.reserve = Math.round((ledger.reserve + allocations.filter((a) => a.action === 'reserve').reduce((s, a) => s + a.amount, 0)) * 100) / 100;
  ledger.entries.push({ eventId: event.id, ticker: event.ticker, confirmedAt: new Date().toISOString(), net: event.tax.net, allocations, tax: event.tax });
  incomeStore.saveLedger(ledger);

  // Reinvesting into the payer adds the shares; anything else is noted for the owner to buy.
  const portfolio = new PortfolioStore();
  const notes: string[] = [];
  for (const a of allocations) {
    if (a.action === 'reinvest' && !a.target && a.units) {
      const pos = portfolio.read().positions.find((x) => x.ticker === event.ticker);
      // Average cost is kept in the holding's own currency, so price the new units in it.
      const basePerLocal = pos ? (pos.currency === baseCurrency() ? 1 : await market.rate(pos.currency, baseCurrency())) : null;
      if (pos && basePerLocal) {
        const localPrice = a.unit_price! / basePerLocal;
        const shares = pos.shares + a.units;
        const avgCost = (pos.shares * pos.avg_cost + a.units * localPrice) / shares;
        portfolio.update((p) => ({
          ...p,
          positions: p.positions.map((x) => (x.ticker === event.ticker ? {
            ...x, shares, avg_cost: Math.round(avgCost * 10_000) / 10_000,
            ...(x.lots ? { lots: [...x.lots, { date: new Date().toISOString().slice(0, 10), shares: a.units!, price: Math.round(localPrice * 10_000) / 10_000 }] } : {}),
          } : x)),
        }));
        notes.push(`added ${formatShares(a.units)} ${event.ticker} to your holding (now ${formatShares(shares)})`);
      } else {
        notes.push(`buy ${formatShares(a.units)} ${event.ticker} for ${money(a.amount)} (holding not found, so not added)`);
      }
    } else if ((a.action === 'reinvest' || a.action === 'repurpose') && a.amount > 0) {
      notes.push(`buy ${a.units ? `${formatShares(a.units)} ` : ''}${a.target ?? event.ticker} for ${money(a.amount)} (not added until you import or add it)`);
    }
  }
  event.status = 'paid';
  incomeStore.saveCalendar(cal.events);
  return [`Recorded ${event.id}: ${money(event.tax.net)} net.`, `Reserve now ${money(ledger.reserve)}.`, ...notes.map((n) => `• ${n}`)].join('\n');
}

export { planFor };
