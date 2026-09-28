import { describe, expect, test } from 'bun:test';

describe('Jev integration', () => {
  test('without a key there are no Jev tools and no calls', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = ''; // not delete: Bun does not reliably drop a variable loaded from .env
    try {
      const { jevAvailable, judge } = await import('./jev.js');
      const { getToolRegistry } = await import('../tools/registry.js');
      expect(jevAvailable()).toBe(false);
      expect(await judge({ kind: 'test', subject: `x-${Date.now()}`, state: {}, questions: {} })).toBeNull();
      const names = getToolRegistry('gpt-4o').map((t) => t.name);
      expect(names).not.toContain('dividend_safety');
      expect(names).toContain('income_calendar');
    } finally {
      if (saved) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test('an unknown cron handler fails loudly instead of doing nothing', async () => {
    const { runCronHandler } = await import('../cron/handlers.js');
    await expect(runCronHandler('nope', { version: 1, jobs: [] })).rejects.toThrow('unknown cron handler');
  });
});

describe('Jev debate verdict', () => {
  test('sends the debate as state with two typed questions and reads the answers back', async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'rubo-jev-'));
    const saved = { key: process.env.TYPESAFE_API_KEY, home: process.env.RUBO_HOME, fetch: globalThis.fetch };
    process.env.TYPESAFE_API_KEY = 'k';
    process.env.RUBO_HOME = home;
    let sent: any;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: 'jev-test', answers: {
        holds: { type: 'noul', noul: 0.62 },
        stronger: { type: 'choice', choice: 'bull', probabilities: { bull: 0.55, bear: 0.3, balanced: 0.15 } },
      } }));
    }) as typeof fetch;
    try {
      const { debateVerdict } = await import('./jev.js');
      const v = await debateVerdict({ thesis: 'KO compounds dividends', ticker: 'KO',
        views: { bull: 'x'.repeat(5000), bear: 'b', quant: 'q', macro: 'm', judge: 'j' } });
      expect(v).toEqual({ thesis_holds: 0.62, stronger_case: 'bull', case_probabilities: { bull: 0.55, bear: 0.3, balanced: 0.15 } });
      expect(sent.model).toBe('jev-latest');
      expect(sent.questions.holds.type).toBe('noul');
      expect(Object.keys(sent.questions.stronger.criteria)).toEqual(['bull', 'bear', 'balanced']);
      expect(sent.state.views.bull.length).toBeLessThan(4100); // long views are cut
      expect(readFileSync(join(home, 'judgements.jsonl'), 'utf8')).toContain('"kind":"debate_verdict"');
    } finally {
      globalThis.fetch = saved.fetch;
      if (saved.key) process.env.TYPESAFE_API_KEY = saved.key; else process.env.TYPESAFE_API_KEY = '';
      if (saved.home) process.env.RUBO_HOME = saved.home; else delete process.env.RUBO_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
