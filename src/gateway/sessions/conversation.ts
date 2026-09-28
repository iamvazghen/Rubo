import { SessionStore, latestSession, listSessions, loadSession } from '../../utils/session-store.js';
import { hasLiveSession, seedSession } from '../agent-runner.js';
import { setActiveSession } from './store.js';

/**
 * Telegram conversations used to live only in the gateway's memory, so every
 * restart (the VPS restarts it daily) silently ended them. Each chat now points
 * at a saved session file - the same format the CLI uses - that every turn is
 * appended to, and that is re-loaded into memory after a restart.
 */
export interface ConversationContext {
  storePath: string;
  sessionKey: string;
  activeSessionId?: string;
  model: string;
}

/** The saved conversation this chat is continuing, started fresh if there is none. */
export async function openConversation(ctx: ConversationContext): Promise<SessionStore> {
  const saved = ctx.activeSessionId ? await loadSession(ctx.activeSessionId) : null;
  if (saved) {
    const store = SessionStore.fromExisting(saved);
    // After a restart memory is empty but the file is not: put the thread back.
    if (!hasLiveSession(ctx.sessionKey)) seedSession(ctx.sessionKey, ctx.model, store.turns);
    return store;
  }
  return startConversation(ctx);
}

function startConversation(ctx: ConversationContext): SessionStore {
  const store = SessionStore.create(ctx.model, 'telegram');
  setActiveSession(ctx.storePath, ctx.sessionKey, store.id);
  seedSession(ctx.sessionKey, ctx.model, []);
  return store;
}

const turnsLabel = (n: number) => `${n} turn${n === 1 ? '' : 's'}`;

/**
 * Session commands, answered by the gateway itself rather than the model.
 * Returns the reply text, or null when the message is not one of them.
 * In groups Telegram appends the bot name (`/new@RuboBot`); that is ignored.
 */
export async function handleSessionCommand(text: string, ctx: ConversationContext): Promise<string | null> {
  const match = /^\/(new|sessions|resume|session)(?:@\S+)?(?:\s+(.*))?$/s.exec(text.trim());
  if (!match) return null;
  const [, command, arg = ''] = match;

  switch (command) {
    case 'new': {
      const store = startConversation(ctx);
      return `New session ${store.id}\nIt is saved after your first question. /sessions lists every saved session.`;
    }

    case 'session':
      return ctx.activeSessionId
        ? `Current session: ${ctx.activeSessionId}\n/new starts another, /sessions lists them all.`
        : 'No saved session yet - it starts with your next question.';

    case 'sessions': {
      const list = (await listSessions()).slice(0, 10);
      if (list.length === 0) return 'No saved sessions yet.';
      const rows = list.map((s) => {
        const current = s.id === ctx.activeSessionId ? '  ← current' : '';
        return `${s.id}\n   ${s.title} · ${turnsLabel(s.turnCount)}${current}`;
      });
      return `Saved sessions, newest first (CLI and Telegram):\n\n${rows.join('\n')}\n\nContinue one with /resume <id>`;
    }

    case 'resume': {
      const wanted = arg.trim();
      const target = wanted
        ? await loadSession(wanted)
        : await latestSession().then(async (latest) =>
            latest && latest.id === ctx.activeSessionId
              ? loadSession((await listSessions())[1]?.id ?? '')
              : latest,
          );
      if (!target) return wanted ? `No session "${wanted}". /sessions lists them.` : 'No previous session to resume.';
      setActiveSession(ctx.storePath, ctx.sessionKey, target.id);
      seedSession(ctx.sessionKey, ctx.model, target.turns);
      return `Resumed ${target.id}\n${target.title} · ${turnsLabel(target.turns.length)}\nAsk your next question to continue it.`;
    }
  }
  return null;
}
