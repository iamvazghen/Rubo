import { yahoo, type MarketData } from '../market/yahoo.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { formatShares } from './messages.js';
import { DEFAULT_YIELD_PLAN, describePlan, parsePlanSpec, planFor } from './plan.js';
import { planEvent, refreshIncome } from './refresh.js';
import { allowanceLeftEur, incomeStore } from './store.js';

/**
 * /income, /yieldplan, /tax, /reserve, /done - shared by the CLI and Telegram so
 * both answer identically. Each returns the text to show.
 */
const usd = (n: number) => `$${n.toFixed(2)}`;

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
    byMonth.set(e.payDate.slice(0, 7), (byMonth.get(e.payDate.slice(0, 7)) ?? 0) + e.tax.net_usd);
    const flag = e.status === 'estimated' ? ' est.' : '';
    return `${e.payDate}  ${e.ticker.padEnd(8)} ${usd(e.gross_usd).padStart(9)} gross  ${usd(e.tax.net_usd).padStart(9)} net${flag}   id ${e.id}`;
  });
  const months = [...byMonth].map(([m, v]) => `${m}: ${usd(v)} net`).join('  ·  ');
  return [
    'Income, next 90 days (USD):', ...rows, '', months,
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
  if (verb === 'set' && key) {
    const acct = /^(\w+)\.(w8ben|domestic|exemption)$/.exec(key);
    if (key === 'residence') t.residence = value.toUpperCase();
    else if (key === 'filing' && (value === 'single' || value === 'joint')) t.filing = value;
    else if (key === 'church') t.church_tax_rate = value === '9' ? 0.09 : value === '8' ? 0.08 : 0;
    else if (acct) {
      const [, name, field] = acct;
      const a = (t.accounts[name!] ??= { domestic: false, w8ben: false, exemption_order_eur: 0 });
      if (field === 'w8ben') a.w8ben = value === 'yes' || value === 'true';
      if (field === 'domestic') a.domestic = value === 'yes' || value === 'true';
      if (field === 'exemption') a.exemption_order_eur = Number(value) || 0;
    } else return `Unknown setting "${key}".`;
    t.confirmed_at = new Date().toISOString();
    incomeStore.saveTax(t);
  } else if (verb === 'confirm') {
    t.confirmed_at = new Date().toISOString();
    incomeStore.saveTax(t);
  }
  const ledger = incomeStore.ledger();
  const lines = [
    `Tax residence: ${t.residence} · filing ${t.filing} · church tax ${t.church_tax_rate ? `${t.church_tax_rate * 100} %` : 'none'}`,
    ...Object.entries(t.accounts).map(([name, a]) =>
      `${name}: ${a.domestic ? 'German broker (withholds tax)' : 'foreign broker (tax via your return)'} · W-8BEN ${a.w8ben ? 'yes' : 'no'}` +
      `${a.domestic ? ` · Freistellungsauftrag €${a.exemption_order_eur}` : ''} · allowance left €${allowanceLeftEur(t, ledger, name).toFixed(0)}`),
  ];
  if (!t.confirmed_at) lines.push('', 'These are defaults, not confirmed. Check them, then /tax confirm.');
  lines.push('', 'Change: /tax set church 8|9|0 · /tax set filing joint · /tax set ibkr.w8ben yes · /tax set traderepublic.exemption 801');
  return lines.join('\n');
}

function reserve(): string {
  const l = incomeStore.ledger();
  const moves = l.entries.slice(-5).flatMap((e) =>
    e.allocations.filter((a) => a.action === 'reserve').map((a) => `  +${usd(a.usd)} from ${e.ticker} (${e.confirmedAt.slice(0, 10)})`));
  return [`Cash reserve for down markets: ${usd(l.reserve_usd)}`, ...(moves.length ? ['Recent:', ...moves] : [])].join('\n');
}

async function done(args: string, market: MarketData): Promise<string> {
  const id = args.trim();
  const cal = incomeStore.calendar();
  const event = cal.events.find((e) => e.id === id) ?? cal.events.find((e) => e.ticker === id.toUpperCase() && e.status !== 'paid');
  if (!event) return `No payment "${id}". /income lists them with their ids.`;
  if (event.status === 'paid') return `${event.id} is already recorded.`;

  const { allocations } = await planEvent(event, market);
  const ledger = incomeStore.ledger();
  const usdPerEur = (await market.usdPerUnit('EUR')) ?? 1.1;
  const year = Number(event.payDate.slice(0, 4));
  const account = event.account ?? Object.keys(incomeStore.tax().accounts)[0] ?? 'default';
  const used = ledger.allowance_used_eur[account];
  ledger.allowance_used_eur[account] = {
    year, eur: (used?.year === year ? used.eur : 0) + event.tax.allowance_used_usd / usdPerEur,
  };
  ledger.reserve_usd = Math.round((ledger.reserve_usd + allocations.filter((a) => a.action === 'reserve').reduce((s, a) => s + a.usd, 0)) * 100) / 100;
  ledger.entries.push({ eventId: event.id, ticker: event.ticker, confirmedAt: new Date().toISOString(), net_usd: event.tax.net_usd, allocations, tax: event.tax });
  incomeStore.saveLedger(ledger);

  // Reinvesting into the payer adds the shares; anything else is noted for the owner to buy.
  const portfolio = new PortfolioStore();
  const notes: string[] = [];
  for (const a of allocations) {
    if (a.action === 'reinvest' && !a.target && a.units) {
      const pos = portfolio.read().positions.find((x) => x.ticker === event.ticker);
      // Average cost is kept in the holding's own currency, so price the new units in it.
      const usdPerLocal = pos ? await market.usdPerUnit(pos.currency) : null;
      if (pos && usdPerLocal) {
        const localPrice = a.unit_price_usd! / usdPerLocal;
        const shares = pos.shares + a.units;
        const avgCost = (pos.shares * pos.avg_cost + a.units * localPrice) / shares;
        portfolio.update((p) => ({
          ...p,
          positions: p.positions.map((x) => (x.ticker === event.ticker ? { ...x, shares, avg_cost: Math.round(avgCost * 10_000) / 10_000 } : x)),
        }));
        notes.push(`added ${formatShares(a.units)} ${event.ticker} to your holding (now ${formatShares(shares)})`);
      } else {
        notes.push(`buy ${formatShares(a.units)} ${event.ticker} for ${usd(a.usd)} (holding not found, so not added)`);
      }
    } else if ((a.action === 'reinvest' || a.action === 'repurpose') && a.usd > 0) {
      notes.push(`buy ${a.units ? `${formatShares(a.units)} ` : ''}${a.target ?? event.ticker} for ${usd(a.usd)} (not added until you import or add it)`);
    }
  }
  event.status = 'paid';
  incomeStore.saveCalendar(cal.events);
  return [`Recorded ${event.id}: ${usd(event.tax.net_usd)} net.`, `Reserve now ${usd(ledger.reserve_usd)}.`, ...notes.map((n) => `• ${n}`)].join('\n');
}

export { planFor };
