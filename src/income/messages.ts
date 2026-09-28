import { ACTION_LABEL, describePlan, type Allocation } from './plan.js';
import type { IncomeEvent } from './store.js';

/**
 * Reminder texts. Built from computed numbers only and delivered verbatim
 * (cron `direct`), so the amounts the owner reads are the amounts computed.
 */
const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (r: number) => `${Math.round(r * 1000) / 10} %`;
const est = (e: IncomeEvent) => (e.status === 'announced' ? '' : ' (estimated)');

export function beforeExMessage(e: IncomeEvent): string {
  const lastDayToHold = new Date(Date.parse(`${e.exDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return [
    `📅 ${e.ticker} goes ex-${e.kind} on ${e.exDate}${est(e)}.`,
    `Keep your ${formatShares(e.shares)} ${e.kind === 'coupon' ? 'bond' : 'shares'} at least through ${lastDayToHold} to receive about ${usd(e.gross_usd)} gross,`,
    `paid on ${e.payDate}${e.payDateEstimated ? ' (estimated)' : ''}.`,
    ...riskLine(e),
  ].join('\n');
}

export function payMessage(e: IncomeEvent, allocations: Allocation[], override: boolean, reserveAfterUsd: number): string {
  const t = e.tax;
  const lines = [
    `💵 ${e.ticker} pays today (${e.payDate})${est(e)}`,
    `${formatShares(e.shares)} × ${e.perShare.toFixed(4)} ${e.currency} = ${usd(t.gross_usd)} gross`,
  ];
  if (t.withholding_usd > 0) lines.push(`Withholding at source ${pct(t.withholding_rate)}: −${usd(t.withholding_usd)}`);
  if (t.residence_tax_settled === 'at_payment' && t.residence_tax_usd > 0) {
    lines.push(`German tax withheld by the broker: −${usd(t.residence_tax_usd)}`);
  } else if (t.residence_tax_settled === 'with_tax_return' && t.residence_tax_usd > 0) {
    lines.push(`German tax due with your return (set aside): −${usd(t.residence_tax_usd)}`);
  }
  if (t.allowance_used_usd > 0) lines.push(`Covered by your tax-free allowance: ${usd(t.allowance_used_usd)}`);
  lines.push(`To use: ${usd(t.net_usd)}`, '', `Your plan${override ? ` for ${e.ticker}` : ''}: ${describePlan(allocations)}`);
  for (const a of allocations) lines.push(`• ${allocationLine(a, e.ticker, reserveAfterUsd)}`);
  lines.push('', `When it is done, reply /done ${e.id}  ·  /income shows what is coming next`);
  lines.push(...riskLine(e));
  if (t.notes.length) lines.push('', `Notes: ${t.notes.join('; ')}.`);
  return lines.join('\n');
}

function allocationLine(a: Allocation, payer: string, reserveAfterUsd: number): string {
  const head = `${a.pct} % ${ACTION_LABEL[a.action]} → ${usd(a.usd)}`;
  if (a.action === 'reserve') return `${head} (reserve becomes ${usd(reserveAfterUsd)})`;
  if (a.action === 'reinvest' || a.action === 'repurpose') {
    const what = a.target ?? (a.action === 'reinvest' ? payer : undefined);
    if (!what) return `${head} (no target set yet: /yieldplan set … repurpose 10 <ticker>)`;
    return a.units ? `${head} ≈ ${a.units} ${what} at ${usd(a.unit_price_usd!)}` : `${head} into ${what}`;
  }
  return head;
}

/** Jev's cut probability, shown only when it is worth a look (20 % or more). */
function riskLine(e: IncomeEvent): string[] {
  return e.cutRisk != null && e.cutRisk >= 0.2
    ? [`Jev puts the chance of a dividend cut within 12 months at ${Math.round(e.cutRisk * 100)} %.`]
    : [];
}

export function cutMessage(e: IncomeEvent): string {
  const change = ((e.perShare - e.previousPerShare!) / e.previousPerShare!) * 100;
  return `⚠️ ${e.ticker}: next ${e.kind} ${e.perShare.toFixed(4)} ${e.currency} per share vs ${e.previousPerShare!.toFixed(4)} last time (${change.toFixed(1)} %).`;
}

export function formatShares(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, '');
}
