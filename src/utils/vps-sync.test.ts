import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { autoSyncTarget, localListing, parseRemoteListing, plan } from './vps-sync.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rubo-sync-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); delete process.env.RUBO_VPS; delete process.env.RUBO_AUTOSYNC; });

describe('sync between the CLI and the server', () => {
  test('only sessions, holdings, income and rebalancing files take part', () => {
    const put = (rel: string, t: number) => {
      mkdirSync(join(home, rel, '..'), { recursive: true });
      writeFileSync(join(home, rel), '{}');
      utimesSync(join(home, rel), t, t);
    };
    put('sessions/cli_2026-09-28_10-00-00.json', 1000);
    put('sessions/default/sessions.json', 1000); // gateway routing metadata: machine-specific
    put('portfolio.json', 2000);
    put('income/tax.json', 3000);
    put('settings.json', 4000); // model and theme are per machine
    expect([...localListing(home)].sort()).toEqual([
      ['income/tax.json', 3000], ['portfolio.json', 2000], ['sessions/cli_2026-09-28_10-00-00.json', 1000],
    ]);
  });

  test('server listing parsing ignores anything outside the synced set', () => {
    const remote = parseRemoteListing('1700000000.1234 ./sessions/telegram_2026-09-28_18-40-03.json\n1700000001.0 ./gateway.json\n1700000002.9 ./income/plan.json\n');
    expect([...remote]).toEqual([['sessions/telegram_2026-09-28_18-40-03.json', 1700000000], ['income/plan.json', 1700000002]]);
  });

  test('newer copy wins each way; equal within a second is left alone', () => {
    const local = new Map([['a.json', 100], ['b.json', 200], ['c.json', 300]]);
    const remote = new Map([['a.json', 150], ['b.json', 201], ['d.json', 50]]);
    expect(plan(local, remote)).toEqual({ pull: ['a.json', 'd.json'], push: ['c.json'] });
  });

  test('off unless RUBO_VPS is set, and RUBO_AUTOSYNC=0 turns it off', () => {
    expect(autoSyncTarget()).toBeNull();
    process.env.RUBO_VPS = 'me@server';
    expect(autoSyncTarget()).toEqual({ host: 'me@server', home: process.env.RUBO_VPS_HOME?.trim() || '~/.rubo' });
    process.env.RUBO_AUTOSYNC = '0';
    expect(autoSyncTarget()).toBeNull();
  });
});
