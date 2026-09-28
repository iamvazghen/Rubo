import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ruboPath } from './paths.js';

/**
 * Keeps the CLI and the server (which runs Telegram and the reminders) looking
 * at the same sessions, holdings and income settings, without `rubo pull/push`.
 *
 * Only when `RUBO_VPS=user@host` is set (and `RUBO_AUTOSYNC` is not `0`). Per
 * file, the newer copy wins; tar carries modification times across so the
 * comparison stays meaningful. Two sides editing the same session are merged by
 * SessionStore.appendTurn, not here. Everything else (memory, scores) stays
 * with the manual `rubo pull` / `rubo push`.
 */

/** Paths under RUBO_HOME that follow the owner between machines. */
const SYNCED = [/^sessions\/[^/]+_[^/]+\.json$/, /^portfolio\.json$/, /^income\/[^/]+\.json$/, /^rebalance\/[^/]+\.json$/];
const DIRS = ['sessions', 'income', 'rebalance'];

export function autoSyncTarget(): { host: string; home: string } | null {
  const host = process.env.RUBO_VPS?.trim();
  if (!host || process.env.RUBO_AUTOSYNC === '0') return null;
  return { host, home: process.env.RUBO_VPS_HOME?.trim() || '~/.rubo' };
}

/** Relative path → mtime in whole seconds. */
export type Listing = Map<string, number>;

export function localListing(root = ruboPath()): Listing {
  const out: Listing = new Map();
  const add = (rel: string) => {
    if (SYNCED.some((r) => r.test(rel))) out.set(rel, Math.floor(statSync(join(root, rel)).mtimeMs / 1000));
  };
  if (existsSync(join(root, 'portfolio.json'))) add('portfolio.json');
  for (const d of DIRS) {
    if (!existsSync(join(root, d))) continue;
    for (const f of readdirSync(join(root, d))) if (statSync(join(root, d, f)).isFile()) add(`${d}/${f}`);
  }
  return out;
}

/** `find -printf '%T@ %p'` output → listing. */
export function parseRemoteListing(text: string): Listing {
  const out: Listing = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\d+)(?:\.\d+)? \.\/(.+)$/.exec(line.trim());
    if (m && SYNCED.some((r) => r.test(m[2]!))) out.set(m[2]!, Number(m[1]));
  }
  return out;
}

/** Files to copy each way. A difference of a second or less is clock rounding, not an edit. */
export function plan(local: Listing, remote: Listing): { pull: string[]; push: string[] } {
  const pull = [...remote].filter(([p, t]) => !local.has(p) || t > local.get(p)! + 1).map(([p]) => p);
  const push = [...local].filter(([p, t]) => !remote.has(p) || t > remote.get(p)! + 1).map(([p]) => p);
  return { pull, push };
}

function run(cmd: string, args: string[], input?: NodeJS.ReadableStream, cwd?: string): { out: Promise<string>; proc: ReturnType<typeof spawn> } {
  const proc = spawn(cmd, args, { cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
  if (input) input.pipe(proc.stdin!);
  const out = new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    proc.stdout!.on('data', (d) => (stdout += d));
    proc.stderr!.on('data', (d) => (stderr += d));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`))));
  });
  return { out, proc };
}

const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8'];

async function remoteListing(host: string, home: string): Promise<Listing> {
  const find = `cd ${home} 2>/dev/null && find . -maxdepth 2 \\( -path './sessions/*' -o -path './income/*' -o -path './rebalance/*' -o -name portfolio.json \\) -type f -printf '%T@ %p\\n' || true`;
  return parseRemoteListing(await run('ssh', [...SSH, host, find]).out);
}

async function transfer(direction: 'pull' | 'push', files: string[], host: string, home: string): Promise<void> {
  const root = ruboPath();
  const quoted = files.map((f) => `'${f}'`).join(' ');
  if (direction === 'pull') {
    const src = run('ssh', [...SSH, host, `cd ${home} && tar cf - ${quoted}`]);
    // tar runs inside the directory: GNU tar (Git for Windows) misreads a C:\ path given to -C.
    const dst = run('tar', ['xf', '-'], src.proc.stdout!, root);
    await Promise.all([src.out.catch(() => ''), dst.out]);
  } else {
    const src = run('tar', ['cf', '-', ...files], undefined, root);
    const dst = run('ssh', [...SSH, host, `mkdir -p ${home}/sessions ${home}/income ${home}/rebalance && cd ${home} && tar xf -`], src.proc.stdout!);
    await Promise.all([src.out.catch(() => ''), dst.out]);
  }
}

let busy: Promise<unknown> = Promise.resolve();

/**
 * One sync pass. `pull` brings newer server files down, `push` sends newer local
 * ones up, `both` does both. Returns a short summary, or null when sync is off.
 * Never throws: a failed sync must not break the CLI.
 */
export async function autoSync(direction: 'pull' | 'push' | 'both'): Promise<string | null> {
  const target = autoSyncTarget();
  if (!target) return null;
  const pass = busy.then(async () => {
    try {
      const { pull, push } = plan(localListing(), await remoteListing(target.host, target.home));
      const doPull = direction !== 'push' && pull.length > 0;
      const doPush = direction !== 'pull' && push.length > 0;
      if (doPull) await transfer('pull', pull, target.host, target.home);
      if (doPush) await transfer('push', push, target.host, target.home);
      return `synced with ${target.host}: ${doPull ? pull.length : 0} down, ${doPush ? push.length : 0} up`;
    } catch (err) {
      return `sync with ${target.host} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    }
  });
  busy = pass;
  return pass;
}
