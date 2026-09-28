import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ruboPath } from './paths.js';
import { getSetting } from './config.js';

/** Where a session was started. Part of the id, so it is visible wherever the id is. */
export type SessionOrigin = 'cli' | 'telegram';

/**
 * A single completed exchange within a session.
 */
export interface SessionTurn {
  query: string;
  answer: string;
  at: string;
}

/**
 * A persisted, resumable conversation thread, from the CLI or from Telegram.
 * One file per session in `.rubo/sessions/`. Either surface can resume a
 * session the other one started, with full multi-turn context restored.
 *
 * Ids are `<origin>:<local date>_<time>`, e.g. `telegram:2026-09-28_14-05-12`:
 * where it started, then when, so a thread can be found by what the user
 * remembers - "the one from Telegram on Monday afternoon".
 */
export interface SessionFile {
  id: string;
  origin: SessionOrigin;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  turns: SessionTurn[];
}

/**
 * Lightweight metadata used when listing sessions (no turn bodies).
 */
export interface SessionSummary {
  id: string;
  origin: SessionOrigin;
  title: string;
  updatedAt: string;
  turnCount: number;
}

const SESSIONS_DIR = 'sessions';

function sessionsDir(): string {
  return ruboPath(SESSIONS_DIR);
}

/** Windows forbids ':' in file names, so the origin separator becomes '_' on disk. */
function sessionPath(id: string): string {
  return join(sessionsDir(), `${id.replace(':', '_')}.json`);
}

/**
 * Local wall-clock time for ids. The gateway runs on a UTC server, so "local" is
 * a setting rather than the machine's clock - otherwise Telegram ids would be
 * two hours off the CLI ones for a user in Köln.
 */
function timeZone(): string {
  return getSetting<string>('timezone', process.env.RUBO_TIMEZONE || 'Europe/Berlin');
}

/** `2026-09-28_14-05-12` in the configured time zone. Sorts chronologically as text. */
export function formatSessionStamp(date: Date, tz = timeZone()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

/** A fresh, unused id. Two sessions started in the same second get a -2, -3 suffix. */
export function makeSessionId(origin: SessionOrigin, date = new Date()): string {
  const base = `${origin}:${formatSessionStamp(date)}`;
  let id = base;
  for (let n = 2; existsSync(sessionPath(id)); n++) id = `${base}-${n}`;
  return id;
}

/** Accepts `cli:…`, `telegram:…`, or the on-disk form `cli_…`. */
export function normalizeSessionId(id: string): string {
  return id.trim().replace(/^(cli|telegram)_/, '$1:');
}

function deriveTitle(query: string): string {
  const firstLine = query.split('\n').find((l) => l.trim()) ?? query;
  const clean = firstLine.trim();
  return clean.length > 70 ? `${clean.slice(0, 70)}…` : clean;
}

/**
 * Manages the lifecycle of one session: create it, append turns as the user
 * works, and persist to disk after every turn so a crash never loses history.
 */
export class SessionStore {
  private session: SessionFile;

  private constructor(session: SessionFile) {
    this.session = session;
  }

  /** Start a brand-new session. */
  static create(model: string, origin: SessionOrigin): SessionStore {
    const date = new Date();
    const now = date.toISOString();
    return new SessionStore({
      id: makeSessionId(origin, date),
      origin,
      title: 'New session',
      createdAt: now,
      updatedAt: now,
      model,
      turns: [],
    });
  }

  /** Wrap an already-loaded session so new turns append to it. */
  static fromExisting(session: SessionFile): SessionStore {
    return new SessionStore(session);
  }

  get id(): string {
    return this.session.id;
  }

  get data(): SessionFile {
    return this.session;
  }

  get turns(): SessionTurn[] {
    return this.session.turns;
  }

  setModel(model: string): void {
    this.session.model = model;
  }

  /** Append a completed turn and persist. The first turn sets the title. */
  async appendTurn(query: string, answer: string): Promise<void> {
    if (this.session.turns.length === 0) {
      this.session.title = deriveTitle(query);
    }
    this.session.turns.push({ query, answer, at: new Date().toISOString() });
    this.session.updatedAt = new Date().toISOString();
    await this.save();
  }

  private async save(): Promise<void> {
    const dir = sessionsDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(sessionPath(this.session.id), JSON.stringify(this.session, null, 2), 'utf-8');
  }
}

/**
 * Sessions saved before ids carried their origin (all of them from the CLI, id
 * `2026-06-18T23-48-34-736Z`) are rewritten once into the current form, so every
 * listing and every `/resume` sees a single scheme. Idempotent.
 */
async function migrateLegacySessions(): Promise<void> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return;
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json') || /^(cli|telegram)_/.test(file)) continue;
    const path = join(dir, file);
    try {
      const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<SessionFile>;
      if (!parsed.createdAt || !Array.isArray(parsed.turns)) continue;
      const migrated = { ...parsed, origin: 'cli', id: makeSessionId('cli', new Date(parsed.createdAt)) } as SessionFile;
      await writeFile(sessionPath(migrated.id), JSON.stringify(migrated, null, 2), 'utf-8');
      await rm(path);
    } catch {
      // Not a session file; leave it alone.
    }
  }
}

/** Load a specific session by id, or null if it doesn't exist / is unreadable. */
export async function loadSession(id: string): Promise<SessionFile | null> {
  await migrateLegacySessions();
  try {
    const content = await readFile(sessionPath(normalizeSessionId(id)), 'utf-8');
    return JSON.parse(content) as SessionFile;
  } catch {
    return null;
  }
}

/** List saved sessions from every surface (or one), newest first. */
export async function listSessions(origin?: SessionOrigin): Promise<SessionSummary[]> {
  await migrateLegacySessions();
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const parsed = JSON.parse(content) as SessionFile;
      // Skip empty sessions (created but never used) so the list stays useful.
      if (!parsed.turns || parsed.turns.length === 0) continue;
      if (!parsed.origin || (origin && parsed.origin !== origin)) continue;
      summaries.push({
        id: parsed.id,
        origin: parsed.origin,
        title: parsed.title,
        updatedAt: parsed.updatedAt,
        turnCount: parsed.turns.length,
      });
    } catch {
      // Ignore malformed files.
    }
  }

  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}

/** The most recently updated non-empty session, or null if none exist. */
export async function latestSession(origin?: SessionOrigin): Promise<SessionFile | null> {
  const summaries = await listSessions(origin);
  const first = summaries[0];
  if (!first) return null;
  return loadSession(first.id);
}
