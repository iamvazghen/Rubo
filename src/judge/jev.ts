import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ruboPath } from '../utils/paths.js';

/**
 * Jev (TypeSafe System One): typed judgements with probabilities.
 *
 * One choke point for every call, like callProvider for market data: key,
 * timeout, a same-day cache and a ledger. Jev is a judgement layer only - it
 * never changes a grade or a computed amount, and it is never asked to predict
 * a price. Every judgement is written to `.rubo/judgements.jsonl` with its date,
 * so it can later be scored against what happened, like the grade ledger.
 */

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type JevQuestion =
  | { type: 'noul'; instructions: string | object; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string | object; criteria: Record<string, string> }
  | { type: 'score'; instructions: string | object; criteria: string[] };

export type JevAnswer = {
  noul?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export function jevAvailable(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

const ledgerPath = () => ruboPath('judgements.jsonl');

function cached(kind: string, subject: string, maxAgeMs: number): Record<string, JevAnswer> | null {
  const path = ledgerPath();
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n').reverse();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { at: string; kind: string; subject: string; answers: Record<string, JevAnswer> };
      if (row.kind === kind && row.subject === subject) {
        return Date.now() - Date.parse(row.at) <= maxAgeMs ? row.answers : null;
      }
    } catch { /* skip a torn line */ }
  }
  return null;
}

/**
 * Ask Jev. `kind` + `subject` identify the judgement for caching and the ledger
 * (e.g. "dividend_safety", "KO"). Returns null when no key is set or the call fails.
 */
export async function judge(p: {
  kind: string;
  subject: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  maxAgeMs?: number;
}): Promise<Record<string, JevAnswer> | null> {
  const hit = cached(p.kind, p.subject, p.maxAgeMs ?? 86_400_000);
  if (hit) return hit;
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (!key) return null;
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: p.state, questions: p.questions }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { answers: Record<string, JevAnswer>; model?: string; usage?: unknown };
    mkdirSync(dirname(ledgerPath()), { recursive: true });
    appendFileSync(ledgerPath(), `${JSON.stringify({ at: new Date().toISOString(), kind: p.kind, subject: p.subject, model: json.model, usage: json.usage, answers: json.answers })}\n`);
    return json.answers;
  } catch {
    return null;
  }
}

export interface DebateVerdict {
  /** Probability the thesis holds over its horizon (12 months when none is stated). */
  thesis_holds: number | null;
  stronger_case: 'bull' | 'bear' | 'balanced' | null;
  case_probabilities?: Record<string, number>;
}

/**
 * A calibrated verdict on a finished bull/bear debate, next to the judge
 * subagent's written synthesis. Jev weighs the arguments as given; it adds no
 * facts. Long answers are cut to keep the request small. Cached for a day.
 */
export async function debateVerdict(p: {
  thesis: string;
  ticker?: string;
  views: Record<'bull' | 'bear' | 'quant' | 'macro' | 'judge', string>;
}): Promise<DebateVerdict | null> {
  const cut = (s: string) => (s.length > 4000 ? `${s.slice(0, 4000)} …` : s);
  const answers = await judge({
    kind: 'debate_verdict',
    subject: `${p.ticker ?? '-'}:${p.thesis.slice(0, 80)}`,
    state: { thesis: p.thesis, ticker: p.ticker ?? null, views: Object.fromEntries(Object.entries(p.views).map(([k, v]) => [k, cut(v)])) },
    questions: {
      holds: {
        type: 'noul',
        instructions: 'Weighing the `views` of the debate, will `thesis` hold over its stated horizon (12 months if none is stated)?',
        criteria: { true: 'the thesis plays out as stated', false: 'it does not' },
      },
      stronger: {
        type: 'choice',
        instructions: 'Which side of the debate in `views` made the better-supported case (evidence, numbers, named catalysts or risks)?',
        criteria: { bull: 'the bull case', bear: 'the bear case', balanced: 'neither clearly' },
      },
    },
  });
  if (!answers) return null;
  return {
    thesis_holds: answers.holds?.noul ?? null,
    stronger_case: (answers.stronger?.choice as DebateVerdict['stronger_case']) ?? null,
    case_probabilities: answers.stronger?.probabilities,
  };
}

/** Probability of a dividend cut in the next 12 months, from fundamentals. Cached for 7 days. */
export async function dividendCutRisk(ticker: string, fundamentals: Record<string, number>): Promise<number | null> {
  const answers = await judge({
    kind: 'dividend_safety',
    subject: ticker,
    maxAgeMs: 7 * 86_400_000,
    state: {
      ticker,
      fundamentals,
      glossary: 'payoutRatio = dividends / earnings; fcfDividendCover = free cash flow / total dividends paid (below 1 means the dividend is not covered by cash); debtToEquity in percent.',
    },
    questions: {
      cut: {
        type: 'noul',
        instructions: `Will ${ticker} cut or suspend its regular dividend within the next 12 months, judged from \`fundamentals\`?`,
        criteria: { true: 'the dividend per share is reduced or suspended', false: 'it is maintained or raised' },
      },
    },
  });
  return answers?.cut?.noul ?? null;
}
