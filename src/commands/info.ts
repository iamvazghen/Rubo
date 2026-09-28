import { readFile } from 'node:fs/promises';
import { getModelCapabilities } from '../model/capabilities.js';
import { theme } from '../theme.js';
import { getActiveProviderNames, getAllProviderNames } from '../tools/finance/providers/index.js';
import { getActiveNewsProviderNames, getAllNewsProviderNames } from '../tools/news/index.js';
import { formatUsd } from '../utils/cost.js';
import { ruboPath } from '../utils/paths.js';
import { clearToolCache, getToolCacheStats } from '../utils/tool-cache.js';

/**
 * CLI slash commands that only report something: each returns the lines to
 * print, so it can be tested without a terminal. Commands that change the CLI's
 * own state (sessions, overlays, the watchlist) stay in cli.ts.
 */

export async function rulesLines(): Promise<string[]> {
  try {
    return [theme.muted('Research Rules:'), await readFile(ruboPath('RULES.md'), 'utf-8')];
  } catch {
    return [theme.muted('No research rules set. Use "add a rule <text>" to create one.')];
  }
}

export function historyLines(messages: { id: number; query: string; answer?: string | null; summary?: string | null }[]): string[] {
  if (messages.length === 0) return [theme.muted('No conversation history yet.')];
  return [
    theme.muted('Recent conversations:'),
    ...messages.flatMap((m) => [
      theme.muted(`  ${m.id + 1}. ${m.query}`),
      theme.muted(`     ${m.summary ?? m.answer?.slice(0, 100) ?? '(pending)'}`),
    ]),
  ];
}

export function thinkingLines(model: string, shown: boolean): string[] {
  const caps = getModelCapabilities(model);
  return [
    `  ${theme.muted('Reasoning blocks:')} ${shown ? theme.success('shown') : theme.muted('hidden')}`,
    caps.reasoning
      ? `  ${theme.muted('Current model')} ${theme.primaryLight(model)} ${theme.muted('is a thinking model — it produces reasoning to show.')}`
      : `  ${theme.muted('Current model')} ${theme.primaryLight(model)} ${theme.muted('does not reason, so no blocks will appear either way.')}`,
  ];
}

export function providersLines(): string[] {
  const all = [...new Set([...getAllProviderNames(), ...getAllNewsProviderNames()])].sort();
  const active = new Set([...getActiveProviderNames(), ...getActiveNewsProviderNames()]);
  return [
    theme.primary('Roadmap data providers'),
    '',
    ...all.map((name) => (active.has(name) ? `  ${theme.success('●')} ${theme.primary(name)}` : `  ${theme.muted('○')} ${theme.muted(name)}`)),
    '',
    theme.muted(`  ${all.filter((n) => active.has(n)).length} of ${all.length} providers active`),
  ];
}

export function costLines(session: { costUsd: number; capUsd: number; tokensIn: number; tokensOut: number }): string[] {
  return [
    `${theme.primary('Session cost')} ${formatUsd(session.costUsd)} · cap ${formatUsd(session.capUsd)}`,
    theme.muted(`  ↓ ${session.tokensIn} in · ↑ ${session.tokensOut} out`),
  ];
}

export function watchlistLines(tickers: string[]): string[] {
  return tickers.length === 0
    ? [theme.muted('No tickers watched. /watch AAPL NVDA')]
    : [theme.primary(`Watchlist (${tickers.length})`), theme.muted(tickers.join(' · '))];
}

export function cacheLines(sub: string): string[] {
  if (sub === 'clear' || sub === 'reset') {
    const before = getToolCacheStats();
    clearToolCache();
    return [theme.success(`⏺ Tool cache cleared (was ${before.size} entries, ${before.totalHits} hits)`)];
  }
  const stats = getToolCacheStats();
  return [
    theme.primary(`Tool cache: ${stats.size} / ${stats.maxEntries} entries, ${stats.totalHits} hits`),
    theme.muted('/cache clear — flush all cached tool results (forces fresh network calls).'),
  ];
}
