import { describe, test, expect, afterAll } from 'bun:test';
import { PortfolioStore } from './store.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('PortfolioStore', () => {
  const tmpDirs: string[] = [];

  function mkStore(): PortfolioStore {
    const dir = mkdtempSync(join(tmpdir(), 'rubo-portfolio-'));
    tmpDirs.push(dir);
    return new PortfolioStore(dir);
  }

  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  test('read on empty store returns empty portfolio', () => {
    const s = mkStore();
    const p = s.read();
    expect(p.positions).toHaveLength(0);
    expect(p.closed).toHaveLength(0);
    expect(p.journal).toHaveLength(0);
    expect(p.notes).toHaveLength(0);
    expect(p.version).toBe(1);
  });

  test('addPosition then read returns the position', () => {
    const s = mkStore();
    const result = s.addPosition({
      ticker: 'AAPL',
      shares: 100,
      avg_cost: 180,
      currency: 'USD',
      opened: '2026-01-15',
      thesis: 'iPhone services flywheel accelerating',
      conviction: 'high',
      target_price: 230,
      stop_loss: 165,
    });
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].ticker).toBe('AAPL');
    expect(result.positions[0].conviction).toBe('high');
  });

  test('addPosition throws on duplicate ticker (case-insensitive)', () => {
    const s = mkStore();
    s.addPosition({
      ticker: 'AAPL', shares: 100, avg_cost: 180, currency: 'USD',
      opened: '2026-01-15', thesis: 't', conviction: 'med',
    });
    expect(() =>
      s.addPosition({
        ticker: 'aapl', shares: 50, avg_cost: 190, currency: 'USD',
        opened: '2026-02-01', thesis: 't', conviction: 'high',
      }),
    ).toThrow(/already open/i);
  });

  test('closePosition moves to closed history and computes P&L', () => {
    const s = mkStore();
    s.addPosition({
      ticker: 'AAPL', shares: 100, avg_cost: 180, currency: 'USD',
      opened: '2026-01-15', thesis: 'test', conviction: 'high',
    });
    const closed = s.update((p) => {
      const pos = p.positions[0];
      const exitPrice = 200;
      const realizedPnl = pos.shares * (exitPrice - pos.avg_cost);
      const realizedPnlPct = ((exitPrice - pos.avg_cost) / pos.avg_cost) * 100;
      return {
        ...p,
        positions: [],
        closed: [
          {
            ...pos,
            closed: '2026-03-01',
            exit_price: exitPrice,
            realized_pnl: realizedPnl,
            realized_pnl_pct: realizedPnlPct,
            lesson: 'test lesson',
          },
          ...p.closed,
        ],
      };
    });
    expect(closed.positions).toHaveLength(0);
    expect(closed.closed).toHaveLength(1);
    expect(closed.closed[0].realized_pnl).toBeCloseTo(2000);
    expect(closed.closed[0].realized_pnl_pct).toBeCloseTo(11.111, 2);
  });

  test('appendJournal prepends to the journal list', () => {
    const s = mkStore();
    s.update((p) => ({
      ...p,
      journal: [
        { date: '2026-01-01', text: 'latest note', category: 'idea' as const },
        ...p.journal,
      ],
    }));
    const r = s.read();
    expect(r.journal[0].text).toBe('latest note');
    expect(r.journal[0].category).toBe('idea');
  });

  test('corrupt JSON file recovers to empty portfolio', () => {
    const s = mkStore();
    s.update((p) => ({ ...p, notes: ['placeholder'] }));
    const path = (s as unknown as { getPath: () => string }).getPath();
    writeFileSync(path, 'not-json{{{', 'utf-8');
    const r = s.read();
    expect(r.positions).toHaveLength(0);
    expect(r.notes).toHaveLength(0);
  });
});