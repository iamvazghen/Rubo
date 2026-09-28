import { describe, expect, test } from 'bun:test';

describe('Jev integration', () => {
  test('without a key there are no Jev tools and no calls', async () => {
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
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
