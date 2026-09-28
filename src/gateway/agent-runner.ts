import { Agent } from '../agent/agent.js';
import { InMemoryChatHistory } from '../utils/in-memory-chat-history.js';
import { createMessageQueue, type MessageQueue, type QueuePriority } from '../utils/message-queue.js';
import { HEARTBEAT_OK_TOKEN } from './heartbeat/suppression.js';
import type { AgentEvent } from '../agent/types.js';
import type { GroupContext } from '../agent/types.js';

type SessionState = {
  history: InMemoryChatHistory;
  tail: Promise<void>;
  queue: MessageQueue;
  isRunning: boolean;
};

const sessions = new Map<string, SessionState>();

function getSession(sessionKey: string, model: string): SessionState {
  const existing = sessions.get(sessionKey);
  if (existing) {
    return existing;
  }
  const created: SessionState = {
    history: new InMemoryChatHistory(model),
    tail: Promise.resolve(),
    queue: createMessageQueue(),
    isRunning: false,
  };
  sessions.set(sessionKey, created);
  return created;
}

/** Whether this process already holds the conversation for a chat in memory. */
export function hasLiveSession(sessionKey: string): boolean {
  return sessions.has(sessionKey);
}

/**
 * Replace a chat's in-memory conversation with saved turns: used after a
 * gateway restart (memory is empty, the file is not) and when the user
 * switches conversation with /new or /resume.
 */
export function seedSession(sessionKey: string, model: string, turns: { query: string; answer: string }[]): void {
  sessions.delete(sessionKey);
  getSession(sessionKey, model).history.loadTurns(turns);
}

/**
 * Check whether an agent is currently running for a given session.
 * Used by the gateway to decide whether to enqueue or start a new turn.
 */
export function isSessionRunning(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.isRunning ?? false;
}

/**
 * Enqueue a message for a session whose agent is currently running.
 * The agent will drain the queue between tool rounds.
 */
export function enqueueForSession(
  sessionKey: string,
  model: string,
  text: string,
  priority: QueuePriority = 'next',
): void {
  const session = getSession(sessionKey, model);
  session.queue.enqueue({
    text,
    priority,
    enqueuedAt: Date.now(),
    source: `gateway:${sessionKey}`,
  });
}

/**
 * A completed agent turn. `reasoning` is non-empty only for thinking models,
 * so a surface can render a labelled thinking block without having to guess
 * whether the model produces one.
 */
export interface AgentReply {
  answer: string;
  reasoning: string;
}

export type AgentRunRequest = {
  sessionKey: string;
  query: string;
  model: string;
  modelProvider: string;
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Each completed turn, as soon as it completes (a follow-up for late messages is its own turn). */
  onTurn?: (turn: { query: string; answer: string; reasoning: string }) => void | Promise<void>;
  isHeartbeat?: boolean;
  /** Run without persistent session history or memory (minimal context, ~95% token savings). */
  isolatedSession?: boolean;
  channel?: string;
  groupContext?: GroupContext;
};

export async function runAgentForMessage(req: AgentRunRequest): Promise<AgentReply> {
  const isolated = req.isolatedSession ?? false;
  const session = isolated ? null : getSession(req.sessionKey, req.model);
  let finalAnswer = '';
  let finalReasoning = '';

  const run = async () => {
    if (session) {
      session.isRunning = true;
      session.history.saveUserQuery(req.query);
    }

    const agent = await Agent.create({
      model: req.model,
      modelProvider: req.modelProvider,
      maxIterations: req.maxIterations ?? 10,
      signal: req.signal,
      channel: req.channel,
      groupContext: req.groupContext,
      memoryEnabled: !isolated,
      messageQueue: session?.queue,
    });

    // One turn per pass: the query, plus anything merged in while it ran. Messages
    // that arrive after the last merge get their own pass, so none is dropped and
    // every answer is delivered and saved with the text it answers.
    let current: typeof agent | null = agent;
    let query = req.query;
    while (current) {
      let answer = '';
      let reasoning = '';
      let answered = query;
      for await (const event of current.run(query, session?.history)) {
        await req.onEvent?.(event);
        if (event.type === 'queue_drain') answered += `\n\n${event.mergedText}`;
        if (event.type === 'done') {
          answer = event.answer;
          reasoning = event.reasoning ?? '';
        }
      }
      if (answer && session) await session.history.saveAnswer(answer);
      if (answer) {
        finalAnswer = answer;
        finalReasoning = reasoning;
        await req.onTurn?.({ query: answered, answer, reasoning });
      }

      current = null;
      if (session && !session.queue.isEmpty()) {
        query = session.queue.dequeueAll().map((m) => m.text).join('\n\n');
        session.history.saveUserQuery(query);
        current = await Agent.create({
          model: req.model,
          modelProvider: req.modelProvider,
          maxIterations: req.maxIterations ?? 10,
          signal: req.signal,
          channel: req.channel,
          groupContext: req.groupContext,
          memoryEnabled: !isolated,
          messageQueue: session.queue,
        });
      }
    }

    // Prune HEARTBEAT_OK turns to avoid context pollution
    if (session && req.isHeartbeat && finalAnswer.trim().toUpperCase().includes(HEARTBEAT_OK_TOKEN)) {
      session.history.pruneLastTurn();
    }

    if (session) {
      session.isRunning = false;
    }
  };

  if (session) {
    // Serialize per-session turns while allowing cross-session concurrency.
    session.tail = session.tail.then(run, run);
    await session.tail;
  } else {
    await run();
  }
  return { answer: finalAnswer, reasoning: finalReasoning };
}
