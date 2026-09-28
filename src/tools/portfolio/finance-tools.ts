/**
 * Agent tools over the income, import and rebalancing features. They call the
 * same code as the /commands, so a question answered in conversation gets the
 * same numbers as the command. Anything that changes state says so: the agent
 * must confirm with the owner first.
 */
import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { runFinanceCommand } from '../../commands/finance.js';
import { formatToolResult } from '../types.js';

const run = async (name: string, args: string) => formatToolResult({ result: await runFinanceCommand(name, args) });

export const incomeCalendar = new DynamicStructuredTool({
  name: 'income_calendar',
  description: 'Dividends, fund distributions and bond coupons due in the next 90 days, gross and net of withholding and German tax, in USD, with event ids.',
  schema: z.object({ refresh: z.boolean().optional().describe('Re-fetch dates and amounts first (slower).') }),
  func: ({ refresh }) => run('income', refresh ? 'refresh' : ''),
});

export const yieldPlanTool = new DynamicStructuredTool({
  name: 'yield_plan',
  description:
    "Show or change the owner's plan for income (reinvest / reserve / withdraw / repurpose, adding to 100 %). Changing it is a durable state change: confirm the exact split with the owner first.",
  schema: z.object({
    action: z.enum(['show', 'set', 'reset']),
    ticker: z.string().optional().describe('Only for this holding (omit for the default plan).'),
    spec: z.string().optional().describe('For set, e.g. "reinvest 40 reserve 30 withdraw 20 repurpose 10 VWCE".'),
  }),
  func: ({ action, ticker, spec }) => run('yieldplan', [action, ticker ?? '', action === 'set' ? spec ?? '' : ''].join(' ')),
});

export const taxProfileTool = new DynamicStructuredTool({
  name: 'tax_profile',
  description:
    "The owner's tax residence, filing status, jurisdiction options and per-account settings (W-8BEN, domestic broker, allowance assigned), plus allowance left. Use before quoting after-tax income. Setting values is a durable change: confirm first.",
  schema: z.object({
    action: z.enum(['show', 'set']),
    key: z.string().optional().describe('residence (2-letter code) | filing | <account>.w8ben | <account>.domestic | <account>.allowance | an option such as church_tax_rate or flat_rate | clear'),
    value: z.string().optional(),
  }),
  func: ({ action, key, value }) => run('tax', action === 'set' ? `set ${key ?? ''} ${value ?? ''}` : ''),
});

export const incomeConfirm = new DynamicStructuredTool({
  name: 'income_confirm',
  description:
    "Record a payment as handled per the owner's plan (updates the cash reserve, allowance used and reinvested shares). Only when the owner says it is done.",
  schema: z.object({ event_id: z.string().describe('Id from income_calendar, e.g. KO:2026-09-15') }),
  func: ({ event_id }) => run('done', event_id),
});

export const rebalanceProposal = new DynamicStructuredTool({
  name: 'rebalance_proposal',
  description:
    'Drift of holdings from the target weights and the trades that would fix it (new cash first, then tax-aware sales). Suggestions only; Rubo never trades.',
  schema: z.object({ new_cash: z.number().optional().describe('Cash the owner will add, in the base currency.') }),
  func: ({ new_cash }) => run('rebalance', new_cash ? `cash ${new_cash}` : ''),
});

export const rebalanceTargets = new DynamicStructuredTool({
  name: 'rebalance_targets',
  description: 'Show or set rebalancing targets: "set stock 50 etf 40 cash 10", "mode holding|asset_type|region|sector", "tag VT region world", "band 5", "min 100", "fee 1 0.1" (fixed + % per trade). Setting is a durable change: confirm first.',
  schema: z.object({ command: z.string().describe('Empty to show, or e.g. "set stock 50 etf 40 cash 10".') }),
  func: ({ command }) => run('targets', command),
});

export const portfolioImport = new DynamicStructuredTool({
  name: 'portfolio_import',
  description:
    'Preview importing holdings from a broker CSV (IBKR statement, or any holdings/transactions table) at a local path (nothing is saved), or apply the waiting preview with confirm=true after the owner agreed.',
  schema: z.object({
    path: z.string().optional().describe('Path to the CSV (for a preview).'),
    broker: z.string().optional().describe('Account name, e.g. ibkr, degiro, traderepublic (detected when omitted).'),
    confirm: z.boolean().optional(),
  }),
  func: ({ path, broker, confirm }) => run('import', confirm ? 'confirm' : `${path ?? ''} ${broker ?? ''}`),
});
