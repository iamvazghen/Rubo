import type { CronStore } from './types.js';

/**
 * Code handlers a cron job can run instead of the agent (payload.handler).
 * Imported lazily so the cron runner does not load the income and rebalancing
 * modules until a job actually needs them.
 */
const HANDLERS: Record<string, (store: CronStore) => Promise<string>> = {
  income_refresh: async (store) => (await import('../income/refresh.js')).refreshIncome({ cronStore: store }),
  rebalance_check: async () => (await import('../rebalance/check.js')).rebalanceCheckMessage(),
};

export async function runCronHandler(name: string, store: CronStore): Promise<string> {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`unknown cron handler "${name}"`);
  return handler(store);
}
