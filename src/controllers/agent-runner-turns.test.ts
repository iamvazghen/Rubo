import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Agent } from '../agent/agent.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { defaultQueue } from '../utils/message-queue.js';
import { AgentRunnerController } from './agent-runner.js';

// The CLI twin of src/gateway/agent-runner.test.ts: every turn is reported to
// onTurn (which saves it to the session) with the exact text it answered.
const scripts: ((q: string) => AsyncGenerator<any>)[] = [];
const realCreate = Agent.create;
const realSummary = (InMemoryChatHistory.prototype as any).generateSummary;
beforeAll(() => {
  (Agent as any).create = async () => {
    const script = scripts.shift()!;
    return { run: (q: string) => script(q) };
  };
  (InMemoryChatHistory.prototype as any).generateSummary = async () => 'summary';
});
afterAll(() => {
  (Agent as any).create = realCreate;
  (InMemoryChatHistory.prototype as any).generateSummary = realSummary;
});

test('CLI: merged and late messages are saved as their own turns', async () => {
  scripts.push(
    async function* () {
      yield { type: 'queue_drain', messageCount: 1, mergedText: 'in EUR please' };
      defaultQueue.enqueue({ text: 'and PEP?', priority: 'next', enqueuedAt: Date.now(), source: 'cli' });
      yield { type: 'done', answer: 'KO answer' };
    },
    async function* () { yield { type: 'done', answer: 'PEP answer' }; },
  );
  const runner = new AgentRunnerController({ model: 'm', modelProvider: 'p' } as any, new InMemoryChatHistory('m'), () => {});
  const turns: [string, string][] = [];
  runner.onTurn = (q, a) => { turns.push([q, a]); };
  const result = await runner.runQuery('how is KO?');
  expect(turns).toEqual([['how is KO?\n\nin EUR please', 'KO answer'], ['and PEP?', 'PEP answer']]);
  expect(result?.answer).toBe('PEP answer');
});
