import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Absolute home for every piece of Rubo state: memory, cron jobs, portfolio,
 * scores, reports.
 *
 * This used to be the bare relative string '.rubo', which meant the process
 * read a *different* brain depending on the directory it was launched from — a
 * scheduled run started anywhere but the repo root silently got empty memory,
 * no portfolio and no cron jobs. Resolved once, at module load, to an absolute
 * path.
 *
 * Order: $RUBO_HOME > ./.rubo if it already exists (back-compat for an
 * existing checkout) > ~/.rubo.
 *
 * The project was called Antoine until 2026-09. Installs that predate the rename
 * (the VPS gateway unit sets ANTOINE_HOME=~/.antoine) keep working: the old
 * variable and the old directory names are honoured only when no Rubo one exists,
 * so state is never split between two directories.
 */
const LEGACY_ENV = 'ANTOINE_HOME';
const LEGACY_DIR = '.antoine';

function envHome(): string {
  return (process.env.RUBO_HOME ?? process.env[LEGACY_ENV] ?? '').trim();
}

function resolveRuboDir(): string {
  const fromEnv = envHome();
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  }

  for (const base of [process.cwd(), homedir()]) {
    if (existsSync(join(base, '.rubo'))) return join(base, '.rubo');
    if (existsSync(join(base, LEGACY_DIR))) return join(base, LEGACY_DIR);
  }

  return join(homedir(), '.rubo');
}

/**
 * Memoised against the value of $RUBO_HOME rather than resolved once and
 * frozen.
 *
 * Freezing at module load meant a process that set RUBO_HOME after the module
 * graph had loaded was silently ignored - so a test that pointed state at a
 * scratch directory still read and wrote the real portfolio, memory and score
 * ledger, depending purely on which file imported first. Three separate suites
 * hit that before it was traced here.
 *
 * Still resolved to an absolute path, which is what the original note was really
 * protecting: a relative '.rubo' meant a scheduled run started outside the
 * repo root read an empty brain.
 */
let cached: { key: string; dir: string } | null = null;

export function getRuboDir(): string {
  const key = envHome();
  if (!cached || cached.key !== key) {
    cached = { key, dir: resolveRuboDir() };
  }
  return cached.dir;
}

export function ruboPath(...segments: string[]): string {
  return join(getRuboDir(), ...segments);
}
