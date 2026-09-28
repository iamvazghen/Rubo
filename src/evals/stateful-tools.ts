/**
 * Exercises the tools the provider health sweep deliberately skips.
 *
 * provider-health.ts skips 16 tools because they mutate state, block for input,
 * or cost real money to run. "Skipped for a reason" and "never tested" look
 * identical in a summary line, so this covers the same list against a scratch
 * RUBO_HOME: the portfolio, memory, cron and heartbeat writes land in a
 * throwaway directory that is deleted at the end, and the real state is never
 * touched.
 *
 * Usage: bun run src/evals/stateful-tools.ts [--expensive]
 *   --expensive also runs spawn_subagent, run_debate and investment_report,
 *   which each cost several LLM calls.
 */
import 'dotenv/config';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before anything reads a path.
const SCRATCH = mkdtempSync(join(tmpdir(), 'rubo-eval-'));
process.env.RUBO_HOME = SCRATCH;
mkdirSync(join(SCRATCH, 'memory'), { recursive: true });
writeFileSync(
  join(SCRATCH, 'memory', 'MEMORY.md'),
  '# Memory\n\n## Owner\n- Placeholder line for the edit test.\n',
  'utf-8',
);

const { getToolRegistry } = await import('../tools/registry.js');
const { DEFAULT_MODEL } = await import('../model/llm.js');

const expensive = process.argv.includes('--expensive');
const registry = getToolRegistry(DEFAULT_MODEL);
const byName = new Map(
  registry.map((t) => [t.name, t.tool as unknown as { invoke: (a: unknown) => Promise<unknown> }]),
);

type Outcome = 'PASS' | 'FAIL' | 'SKIP';
const results: Array<{ tool: string; outcome: Outcome; note: string }> = [];

function record(tool: string, outcome: Outcome, note: string) {
  results.push({ tool, outcome, note });
  const mark = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'skip' }[outcome];
  console.log(`${mark} ${tool.padEnd(22)} ${note.replace(/\s+/g, ' ').slice(0, 130)}`);
}

async function call(tool: string, args: Record<string, unknown>): Promise<string> {
  const t = byName.get(tool);
  if (!t) throw new Error('not registered');
  return String(await t.invoke(args));
}

/** Run one step and record it; `check` decides whether the output is a pass. */
async function step(
  tool: string,
  args: Record<string, unknown>,
  check: (out: string) => boolean,
  label = '',
): Promise<string | null> {
  try {
    const out = await call(tool, args);
    const ok = check(out);
    record(tool, ok ? 'PASS' : 'FAIL', `${label}${label ? ' — ' : ''}${out}`);
    return ok ? out : null;
  } catch (e) {
    record(tool, 'FAIL', `${label}${label ? ' — ' : ''}${(e as Error).message}`);
    return null;
  }
}

const has = (needle: string) => (out: string) => out.toLowerCase().includes(needle.toLowerCase());
const noError = (out: string) => !/"success"\s*:\s*false|^error|"error"\s*:/i.test(out.trim());

console.log(`scratch RUBO_HOME: ${SCRATCH}`);
console.log(`registry: ${registry.length} tools\n--- filesystem`);

// ---------------------------------------------------------------- filesystem
const testFile = '.rubo-eval-scratch.txt';
await step('write_file', { path: testFile, content: 'hello\nsecond line\n' }, has('bytesWritten'));
await step('read_file', { path: testFile }, has('second line'));
await step(
  'edit_file',
  { path: testFile, old_text: 'second line', new_text: 'edited line' },
  noError,
);
await step('read_file', { path: testFile }, has('edited line'), 'after edit');
if (existsSync(testFile)) rmSync(testFile);

console.log('--- portfolio');
await step('portfolio_set_risk', { total_capital_usd: 100_000, risk_budget_pct: 1 }, noError);
await step(
  'portfolio_add',
  {
    ticker: 'ZZTEST',
    shares: 10,
    avg_cost: 100,
    currency: 'USD',
    opened: '2026-09-01',
    thesis: 'Evaluation harness position; removed in the same run.',
    conviction: 'low',
  },
  noError,
);
await step('portfolio_view', {}, has('ZZTEST'), 'position visible');
await step('portfolio_journal', { text: 'Harness entry.', category: 'observation' }, noError);
await step(
  'portfolio_remove',
  { ticker: 'ZZTEST', exit_price: 110, closed: '2026-09-07', lesson: 'Harness close.' },
  noError,
);
await step('portfolio_view', {}, has('"open_count":0'), 'position closed');

console.log('--- memory');
await step('memory_update', { action: 'append', file: 'MEMORY.md', content: '- Harness line.' }, noError);
await step('memory_get', { path: 'MEMORY.md' }, has('Harness line'), 'append visible');
await step(
  'memory_update',
  { action: 'delete', file: 'MEMORY.md', old_text: '- Harness line.' },
  noError,
);

console.log('--- scheduling');
await step('heartbeat', { action: 'view' }, noError);
await step('cron', { action: 'list' }, noError);
const added = await step(
  'cron',
  {
    action: 'add',
    name: 'rubo-eval-temp',
    schedule: { kind: 'every', everyMs: 86_400_000 },
    message: 'Evaluation harness job; removed in the same run.',
  },
  noError,
);
const jobId = added?.match(/([0-9a-f]{16})/)?.[1];
if (jobId) {
  await step('cron', { action: 'remove', jobId }, noError, 'cleanup');
} else {
  record('cron', 'FAIL', 'added a job but could not parse its id back out to remove it');
}

console.log('--- dispatch');
await step('skill', { skill: 'definitely-not-a-skill' }, has('not found'), 'unknown skill errors');

console.log('--- browser');
// Playwright cannot launch under Bun on Windows. That is an environment limit,
// not a defect, and reporting it as a failure made this script exit 1 on every
// local run - which is how a real failure gets ignored.
const { browserLaunchBlockReason } = await import('../tools/browser/browser.js');
const browserBlocked = browserLaunchBlockReason({
  isBun: typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined',
  platform: process.platform,
  force: process.env.RUBO_BROWSER_FORCE === '1',
});
if (browserBlocked) {
  record('browser', 'SKIP', browserBlocked);
} else {
  await step('browser', { action: 'navigate', url: 'https://example.com' }, noError);
  await step('browser', { action: 'snapshot', maxChars: 400 }, has('example'), 'page content');
  await step('browser', { action: 'close' }, noError);
}

if (expensive) {
  console.log('--- expensive (LLM-backed)');
  await step(
    'spawn_subagent',
    {
      description: 'Harness liveness check',
      task: 'Reply with exactly the word READY and nothing else.',
    },
    noError,
  );
  await step('investment_report', { horizon: 'long', top_n: 2, tickers: ['AAPL', 'KO'] }, noError);
  await step(
    'run_debate',
    { thesis: 'Long KO: a defensive dividend compounder at a fair multiple.', ticker: 'KO' },
    noError,
  );
} else {
  for (const t of ['spawn_subagent', 'investment_report', 'run_debate']) {
    record(t, 'SKIP', 'costs several LLM calls; re-run with --expensive');
  }
}

// ask_user_question blocks on a real prompt; there is nothing to call here.
record(
  'ask_user_question',
  byName.has('ask_user_question') ? 'PASS' : 'FAIL',
  byName.has('ask_user_question')
    ? 'registered; blocks for interactive input so it cannot be driven headlessly'
    : 'NOT REGISTERED',
);

try {
  rmSync(SCRATCH, { recursive: true, force: true });
} catch {
  // Windows keeps a handle on the sqlite memory store; the OS reaps /tmp anyway.
}

const count = (o: Outcome) => results.filter((r) => r.outcome === o).length;
console.log('\n--- summary');
console.log(`pass: ${count('PASS')}  fail: ${count('FAIL')}  skip: ${count('SKIP')}`);
for (const r of results.filter((x) => x.outcome === 'FAIL')) {
  console.log(`  FAIL ${r.tool.padEnd(22)} ${r.note.slice(0, 200)}`);
}
process.exit(count('FAIL') > 0 ? 1 : 0);
