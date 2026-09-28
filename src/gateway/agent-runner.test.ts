import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Agent } from '../agent/agent.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { enqueueForSession, runAgentForMessage } from './agent-runner.js';

/**
 * Messages sent while Rubo is still answering: merged into the running turn when
 * the agent drains its queue, or answered in a follow-up turn when they arrive
 * after the last drain. Every answer must reach the owner and the saved session.
 */
type Script = (query: string) => AsyncGenerator<any>;
const scripts: Script[] = [];
const realCreate = Agent.create;
const realSummary = (InMemoryChatHistory.prototype as any).generateSummary;

beforeAll(() => {
  (Agent as any).create = async () => {
    const script = scripts.shift()!;
    return { run: (query: string) => script(query) };
  };
  (InMemoryChatHistory.prototype as any).generateSummary = async () => 'summary';
});
afterAll(() => {
  (Agent as any).create = realCreate;
  (InMemoryChatHistory.prototype as any).generateSummary = realSummary;
});

describe('gateway turns', () => {
  test('a message that arrives after the last drain gets its own answer; the first answer is not lost', async () => {
    const key = 'test:late';
    scripts.push(
      async function* (q) {
        enqueueForSession(key, 'm', 'and what about PEP?'); // arrives while this turn is finishing
        yield { type: 'done', answer: `answer to ${q}` };
      },
      async function* (q) {
        yield { type: 'done', answer: `answer to ${q}` };
      },
    );
    const turns: { query: string; answer: string }[] = [];
    const reply = await runAgentForMessage({
      sessionKey: key, query: 'how is KO?', model: 'm', modelProvider: 'p',
      onTurn: (t) => { turns.push({ query: t.query, answer: t.answer }); },
    });
    expect(turns).toEqual([
      { query: 'how is KO?', answer: 'answer to how is KO?' },
      { query: 'and what about PEP?', answer: 'answer to and what about PEP?' },
    ]);
    expect(reply.answer).toBe('answer to and what about PEP?');
  });

  test('a message merged mid-run is saved as part of the question it was answered with', async () => {
    scripts.push(async function* () {
      yield { type: 'queue_drain', messageCount: 1, mergedText: 'also check the payout ratio' };
      yield { type: 'done', answer: 'both answered' };
    });
    const turns: string[] = [];
    await runAgentForMessage({
      sessionKey: 'test:merged', query: 'is the KO dividend safe?', model: 'm', modelProvider: 'p',
      onTurn: (t) => { turns.push(t.query); },
    });
    expect(turns).toEqual(['is the KO dividend safe?\n\nalso check the payout ratio']);
  });

  test('an empty answer is not reported as a turn', async () => {
    scripts.push(async function* () { yield { type: 'done', answer: '' }; });
    let calls = 0;
    await runAgentForMessage({ sessionKey: 'test:empty', query: 'x', model: 'm', modelProvider: 'p', onTurn: () => { calls++; } });
    expect(calls).toBe(0);
  });
});
