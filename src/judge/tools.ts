import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { yahoo } from '../market/yahoo.js';
import { PortfolioStore } from '../tools/portfolio/store.js';
import { formatToolResult } from '../tools/types.js';
import { dividendCutRisk, judge } from './jev.js';

/**
 * Jev judgement tools. Their output is a probability and must be presented as
 * one ("Jev puts the chance of a cut at 12 %"), never as a fact, and never used
 * to change a grade.
 */

export const dividendSafety = new DynamicStructuredTool({
  name: 'dividend_safety',
  description:
    'Probability (0-1, from Jev) that a company cuts or suspends its dividend in the next 12 months, judged from payout ratio, free-cash-flow cover, debt and growth. Present it as a probability, not a verdict.',
  schema: z.object({ ticker: z.string().describe('Ticker, e.g. KO or DTE.DE') }),
  func: async ({ ticker }) => {
    const symbol = ticker.toUpperCase();
    const fundamentals = await yahoo.fundamentals(symbol);
    if (!fundamentals) return formatToolResult({ ok: false, error: `no fundamentals for ${symbol}` });
    const p = await dividendCutRisk(symbol, fundamentals);
    return formatToolResult({ ok: p != null, ticker: symbol, cut_probability_12m: p, fundamentals, source: 'Jev (TypeSafe) judgement on Yahoo fundamentals' });
  },
});

export const thesisCheck = new DynamicStructuredTool({
  name: 'thesis_check',
  description:
    "Ask Jev whether the owner's stored thesis for a holding still holds given new evidence (results, guidance, news you have already gathered). Returns probabilities. Use after results or major news on a held position.",
  schema: z.object({
    ticker: z.string(),
    evidence: z.string().describe('The new facts, summarised with numbers and dates.'),
  }),
  func: async ({ ticker, evidence }) => {
    const position = new PortfolioStore().read().positions.find((p) => p.ticker === ticker.toUpperCase());
    if (!position) return formatToolResult({ ok: false, error: `${ticker} is not held` });
    const answers = await judge({
      kind: 'thesis_check',
      subject: `${position.ticker}:${evidence.slice(0, 80)}`,
      state: { holding: { ticker: position.ticker, thesis: position.thesis, opened: position.opened, conviction: position.conviction }, evidence },
      questions: {
        intact: { type: 'noul', instructions: 'Is the `holding` thesis still intact given `evidence`?' },
        direction: {
          type: 'choice',
          instructions: 'How does `evidence` bear on the thesis?',
          criteria: { strengthens: 'supports the thesis', neutral: 'does not change it', weakens: 'undermines it' },
        },
      },
    });
    return formatToolResult({ ok: answers != null, ticker: position.ticker, thesis: position.thesis,
      intact_probability: answers?.intact?.noul, direction: answers?.direction?.choice, direction_probabilities: answers?.direction?.probabilities });
  },
});

export const newsMateriality = new DynamicStructuredTool({
  name: 'news_materiality',
  description:
    'Ask Jev whether a news item is material to a held position (and in which direction), relative to the stored thesis. Use to filter news before alerting the owner.',
  schema: z.object({ ticker: z.string(), news: z.string().describe('Headline and key sentences, with date and source.') }),
  func: async ({ ticker, news }) => {
    const position = new PortfolioStore().read().positions.find((p) => p.ticker === ticker.toUpperCase());
    const answers = await judge({
      kind: 'news_materiality',
      subject: `${ticker.toUpperCase()}:${news.slice(0, 80)}`,
      state: { ticker: ticker.toUpperCase(), thesis: position?.thesis ?? null, news },
      questions: {
        material: { type: 'noul', instructions: 'Is `news` material to an investor holding this position with this `thesis` (would it plausibly change their decision)?' },
        direction: { type: 'choice', instructions: 'Direction of the likely impact on the position.', criteria: { positive: 'positive', neutral: 'neutral or unclear', negative: 'negative' } },
      },
    });
    return formatToolResult({ ok: answers != null, material_probability: answers?.material?.noul, direction: answers?.direction?.choice, direction_probabilities: answers?.direction?.probabilities });
  },
});
