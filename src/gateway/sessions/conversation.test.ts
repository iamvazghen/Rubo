import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * State goes to a scratch RUBO_HOME. The store modules resolve their directory
 * per call (see utils/paths.ts), and the imports are dynamic so nothing can have
 * captured the real home before the override.
 */
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'rubo-conv-'));
  process.env.RUBO_HOME = home;
  process.env.RUBO_TIMEZONE = 'Europe/Berlin';
});
afterEach(() => {
  delete process.env.RUBO_HOME;
  delete process.env.RUBO_TIMEZONE;
  rmSync(home, { recursive: true, force: true });
});

const load = async () => ({
  ...(await import('../../utils/session-store.js')),
  ...(await import('./conversation.js')),
  ...(await import('./store.js')),
  ...(await import('../agent-runner.js')),
});

function chat(m: Awaited<ReturnType<typeof load>>, key = 'agent:default:telegram:default:direct:42') {
  const storePath = m.resolveSessionStorePath('default');
  const entry = () =>
    m.upsertSessionMeta({ storePath, sessionKey: key, channel: 'telegram', to: '42', accountId: 'default', agentId: 'default' });
  const ctx = () => ({ storePath, sessionKey: key, activeSessionId: entry().activeSessionId, model: 'test-model' });
  return { ctx };
}

describe('session ids', () => {
  test('carry where the session started, then local date and time', async () => {
    const m = await load();
    // 12:05:09 UTC is 14:05:09 in Köln in September.
    expect(m.formatSessionStamp(new Date('2026-09-28T12:05:09Z'))).toBe('2026-09-28_14-05-09');
    expect(m.makeSessionId('telegram', new Date('2026-09-28T12:05:09Z'))).toBe('telegram:2026-09-28_14-05-09');
    expect(m.makeSessionId('cli', new Date('2026-09-28T12:05:09Z'))).toBe('cli:2026-09-28_14-05-09');
  });

  test('two sessions started in the same second do not collide', async () => {
    const m = await load();
    const s = m.SessionStore.create('x', 'cli');
    await s.appendTurn('q', 'a');
    const again = m.makeSessionId('cli', new Date(s.data.createdAt));
    expect(again).toBe(`${s.id}-2`);
  });

  test('sessions saved before origin tags are converted once into cli: ids', async () => {
    const m = await load();
    const dir = join(home, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-06-18T23-48-34-736Z.json'),
      JSON.stringify({ id: '2026-06-18T23-48-34-736Z', title: 'old', createdAt: '2026-06-18T23:48:34.736Z', updatedAt: '2026-06-18T23:50:00.000Z', model: 'm', turns: [{ query: 'q', answer: 'a', at: 'x' }] }),
    );
    const list = await m.listSessions();
    expect(list.map((s) => s.id)).toEqual(['cli:2026-06-19_01-48-34']);
    expect(existsSync(join(dir, '2026-06-18T23-48-34-736Z.json'))).toBe(false);
    expect(readdirSync(dir)).toContain('cli_2026-06-19_01-48-34.json');
  });
});

describe('telegram conversations', () => {
  test('keep appending to the same saved file, message after message', async () => {
    const m = await load();
    const { ctx } = chat(m);

    const first = await m.openConversation(ctx());
    await first.appendTurn('What is NVDA trading at?', 'About $1,284.');
    expect(first.id.startsWith('telegram:')).toBe(true);

    const reopened = await m.openConversation(ctx());
    expect(reopened.id).toBe(first.id);
    await reopened.appendTurn('And its grade?', '78/100.');
    const saved = await m.loadSession(first.id);
    expect(saved?.turns.map((t) => t.query)).toEqual(['What is NVDA trading at?', 'And its grade?']);
  });

  test('a chat with nothing in memory (as after a restart) is reloaded from its saved file', async () => {
    const m = await load();
    const saved = m.SessionStore.create('x', 'telegram');
    await saved.appendTurn('Grade NVDA', '78/100.');

    // A chat this process has never seen, pointed at the saved thread - the
    // state every chat is in right after the gateway restarts.
    const { ctx } = chat(m, 'agent:default:telegram:default:direct:99');
    m.setActiveSession(ctx().storePath, ctx().sessionKey, saved.id);
    expect(m.hasLiveSession(ctx().sessionKey)).toBe(false);

    const reopened = await m.openConversation(ctx());
    expect(reopened.id).toBe(saved.id);
    expect(reopened.turns.length).toBe(1);
    expect(m.hasLiveSession(ctx().sessionKey)).toBe(true);
  });

  test('/new starts a fresh telegram: session, /sessions lists both surfaces, /resume switches back', async () => {
    const m = await load();
    const { ctx } = chat(m);
    const cli = m.SessionStore.create('x', 'cli');
    await cli.appendTurn('Grade AAPL', '71/100.');

    const one = await m.openConversation(ctx());
    await one.appendTurn('Hello', 'Hi.');

    const reply = await m.handleSessionCommand('/new', ctx());
    expect(reply).toContain('New session telegram:');
    expect(ctx().activeSessionId).not.toBe(one.id);

    const listing = await m.handleSessionCommand('/sessions@RuboBot', ctx());
    expect(listing).toContain(one.id);
    expect(listing).toContain(cli.id);

    // A Telegram chat can pick up a thread that was started in the CLI.
    const resumed = await m.handleSessionCommand(`/resume ${cli.id}`, ctx());
    expect(resumed).toContain(`Resumed ${cli.id}`);
    expect(ctx().activeSessionId).toBe(cli.id);
    const continued = await m.openConversation(ctx());
    await continued.appendTurn('And MSFT?', '74/100.');
    expect((await m.loadSession(cli.id))?.turns.length).toBe(2);
  });

  test('ordinary messages are not treated as commands', async () => {
    const m = await load();
    const { ctx } = chat(m);
    expect(await m.handleSessionCommand('what about /new highs in NVDA?', ctx())).toBeNull();
    expect(await m.handleSessionCommand('/grade AAPL', ctx())).toBeNull();
  });
});
