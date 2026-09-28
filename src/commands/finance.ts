import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { INCOME_COMMANDS, runIncomeCommand, type IncomeCommand } from '../income/commands.js';
import { cancelImport, confirmImport, describePreview, previewImport } from '../importer/apply.js';
import { runRebalanceCommand } from '../rebalance/check.js';

/**
 * Money commands answered by code, not the model, identically in the CLI and
 * on Telegram. Returns the reply, or null when `name` is not one of them.
 */
export const FINANCE_COMMANDS = [...INCOME_COMMANDS, 'import', 'targets', 'rebalance'] as const;

/** Which account an export belongs to: stated by the owner, or recognised from the file. */
export function detectAccount(hint: string, fileName: string, text: string): string {
  const h = `${hint} ${fileName}`.toLowerCase();
  if (/\bibkr\b|interactive|\bu\d{6,}/.test(h) || /^Statement,|Open Positions,Header/m.test(text)) return 'ibkr';
  if (/trade ?republic|\btr\b/.test(h)) return 'traderepublic';
  return 'traderepublic';
}

export async function importFromText(text: string, fileName: string, hint = ''): Promise<string> {
  const account = detectAccount(hint, fileName, text);
  return describePreview(await previewImport(text, account));
}

export async function runFinanceCommand(name: string, args: string): Promise<string | null> {
  if ((INCOME_COMMANDS as readonly string[]).includes(name)) return runIncomeCommand(name as IncomeCommand, args);
  if (name === 'targets' || name === 'rebalance') return runRebalanceCommand(name, args);
  if (name === 'import') {
    const [first = '', ...rest] = args.trim().split(/\s+/);
    if (first === 'confirm') return confirmImport();
    if (first === 'cancel') return cancelImport();
    if (!first) return 'Import a broker export: /import <path to CSV> [ibkr|traderepublic] - or send the CSV to the Telegram bot.';
    const path = first.replace(/^["']|["']$/g, '');
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch { return `Cannot read "${path}".`; }
    return importFromText(text, basename(path), rest.join(' '));
  }
  return null;
}
