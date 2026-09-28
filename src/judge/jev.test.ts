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

describe('monthly thesis check job', () => {
  test('created once with a key, never without one, and it names tools that exist', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const home = mkdtempSync(join(tmpdir(), 'rubo-thesis-'));
    const saved = { key: process.env.TYPESAFE_API_KEY, home: process.env.RUBO_HOME };
    process.env.RUBO_HOME = home;
    try {
      const { ensureThesisCheckJob, THESIS_JOB, THESIS_JOB_MESSAGE } = await import('./jobs.js');
      const { loadCronStore } = await import('../cron/store.js');
      process.env.TYPESAFE_API_KEY = '';
      ensureThesisCheckJob();
      expect(loadCronStore().jobs).toHaveLength(0);
      process.env.TYPESAFE_API_KEY = 'k';
      ensureThesisCheckJob();
      ensureThesisCheckJob();
      const jobs = loadCronStore().jobs.filter((j) => j.name === THESIS_JOB);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.schedule).toMatchObject({ kind: 'cron', expr: '0 9 15 * *' });
      expect(jobs[0]!.payload.direct).toBeUndefined(); // a model job: it gathers the evidence
      const { getToolRegistry } = await import('../tools/registry.js');
      const names = getToolRegistry('gpt-4o').map((t) => t.name);
      for (const tool of ['portfolio_view', 'thesis_check']) {
        expect(THESIS_JOB_MESSAGE).toContain(tool);
        expect(names).toContain(tool);
      }
    } finally {
      if (saved.key) process.env.TYPESAFE_API_KEY = saved.key; else process.env.TYPESAFE_API_KEY = '';
      if (saved.home) process.env.RUBO_HOME = saved.home; else delete process.env.RUBO_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('scoring Jev against what happened', () => {
  const div = (d: string, a: number) => ({ exDate: d, amount: a });
  const history = [div('2024-03-01', 0.5), div('2024-06-01', 0.5), div('2024-09-01', 0.5), div('2024-12-01', 0.5),
    div('2025-03-01', 0.5), div('2025-06-01', 0.25), div('2025-09-01', 0.25)];

  test('a cut is a lower payment than the last one before the judgement, within a year', async () => {
    const { dividendCutOutcome } = await import('./score.js');
    const now = Date.parse('2026-09-28');
    expect(dividendCutOutcome(history, '2025-01-15T00:00:00Z', now)).toBe(true); // 0.25 in June 2025
    expect(dividendCutOutcome(history, '2024-02-01T00:00:00Z', now)).toBeNull(); // nothing earlier to compare with
    expect(dividendCutOutcome(history.slice(0, 5), '2024-05-15T00:00:00Z', now)).toBe(false); // kept at 0.5
    expect(dividendCutOutcome(history, '2026-01-15T00:00:00Z', now)).toBeNull(); // less than a year ago
    expect(dividendCutOutcome(history.slice(0, 4), '2024-12-15T00:00:00Z', now)).toBe(true); // nothing paid: suspended
  });

  test('Brier score against the base rate; weekly repeats of the same call count once a month', async () => {
    const { scoreJudgements, describeScores } = await import('./score.js');
    const market = { dividendHistory: async (s: string) => (s === 'CUT' ? { currency: 'USD', instrumentType: 'EQUITY', dividends: history }
      : { currency: 'USD', instrumentType: 'EQUITY', dividends: history.slice(0, 5) }) } as any;
    const j = (subject: string, at: string, p: number) => ({ at, kind: 'dividend_safety', subject, answers: { cut: { noul: p } } });
    const r = await scoreJudgements(market, Date.parse('2026-09-28'), [
      j('CUT', '2025-01-15T00:00:00Z', 0.8), j('CUT', '2025-01-22T00:00:00Z', 0.8), // same month: one
      j('KEPT', '2024-05-15T00:00:00Z', 0.1),
      j('KEPT', '2026-08-01T00:00:00Z', 0.2), // not resolved yet
      { at: '2026-01-01T00:00:00Z', kind: 'thesis_check', subject: 'KO:x', answers: {} },
    ]);
    expect(r.resolved.map((x) => [x.subject, x.cut])).toEqual([['CUT', true], ['KEPT', false]]);
    expect(r.brier).toBeCloseTo(((0.8 - 1) ** 2 + 0.1 ** 2) / 2, 6); // 0.025
    expect(r.baseline).toBeCloseTo(0.25, 6);
    expect(r.pending).toBe(1);
    expect(describeScores(r)).toContain(': better than naive');
  });
});
