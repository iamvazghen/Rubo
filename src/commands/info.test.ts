import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getModelCapabilities } from '../model/capabilities.js';
import { cacheLines, costLines, historyLines, providersLines, rulesLines, thinkingLines, watchlistLines } from './info.js';

// Colours are not what is being tested.
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rubo-info-')); process.env.RUBO_HOME = home; });
afterEach(() => { delete process.env.RUBO_HOME; rmSync(home, { recursive: true, force: true }); });

describe('report-only CLI commands', () => {
  test('/rules: the rules file, or how to start one', async () => {
    expect(plain(await rulesLines())).toEqual(['No research rules set. Use "add a rule <text>" to create one.']);
    writeFileSync(join(home, 'RULES.md'), '- never average down');
    expect(plain(await rulesLines())).toEqual(['Research Rules:', '- never average down']);
  });

  test('/history: numbered from 1, summary when there is one, else the answer start', () => {
    expect(plain(historyLines([]))).toEqual(['No conversation history yet.']);
    expect(plain(historyLines([
      { id: 0, query: 'grade KO', summary: 'KO: B long, C short' },
      { id: 1, query: 'and PEP?', answer: 'x'.repeat(150), summary: null },
      { id: 2, query: 'still running', answer: null },
    ]))).toEqual([
      'Recent conversations:',
      '  1. grade KO', '     KO: B long, C short',
      '  2. and PEP?', `     ${'x'.repeat(100)}`,
      '  3. still running', '     (pending)',
    ]);
  });

  test('/thinking: says whether the current model reasons at all', () => {
    const [shown, model] = plain(thinkingLines('gpt-4o', true));
    expect(shown).toBe('  Reasoning blocks: shown');
    expect(model).toContain(getModelCapabilities('gpt-4o').reasoning ? 'is a thinking model' : 'does not reason');
    expect(plain(thinkingLines('gpt-4o', false))[0]).toBe('  Reasoning blocks: hidden');
  });

  test('/providers: every provider once, and the active count matches the markers', () => {
    const lines = plain(providersLines());
    const rows = lines.filter((l) => /^ {2}[●○] /.test(l));
    const names = rows.map((l) => l.slice(4));
    expect(new Set(names).size).toBe(names.length);
    const active = rows.filter((l) => l.startsWith('  ●')).length;
    expect(lines.at(-1)).toBe(`  ${active} of ${rows.length} providers active`);
  });

  test('/cost, /watchlist and /cache', () => {
    expect(plain(costLines({ costUsd: 0.1234, capUsd: 5, tokensIn: 1200, tokensOut: 300 }))[1]).toBe('  ↓ 1200 in · ↑ 300 out');
    expect(plain(watchlistLines([]))).toEqual(['No tickers watched. /watch AAPL NVDA']);
    expect(plain(watchlistLines(['KO', 'PEP']))).toEqual(['Watchlist (2)', 'KO · PEP']);
    expect(plain(cacheLines(''))[0]).toMatch(/^Tool cache: \d+ \/ \d+ entries, \d+ hits$/);
    expect(plain(cacheLines('clear'))[0]).toMatch(/^⏺ Tool cache cleared/);
    expect(plain(cacheLines(''))[0]).toMatch(/^Tool cache: 0 \//);
  });
});
