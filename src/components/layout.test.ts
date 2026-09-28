import { describe, expect, test } from 'bun:test';
import { visibleWidth } from '@mariozechner/pi-tui';
import { AnswerBoxComponent } from './answer-box.js';
import { IntroComponent } from './intro.js';
import { box, fitSegments, hangingWrap } from './layout.js';
import { StatusBarComponent } from './status-bar.js';
import { UserQueryComponent } from './user-query.js';

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const WIDTHS = [160, 100, 72, 60, 40, 30, 24, 20];

describe('layout follows the window', () => {
  test('the frame is exactly as wide as it is allowed to be, at every width', () => {
    for (const w of WIDTHS) {
      const lines = box(['a line of text that is long enough to wrap in narrow windows'], w, 72);
      const expected = Math.min(w, 72);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(expected);
      if (expected >= 24) {
        // Top and bottom edges span the full box: it grows and shrinks with the window.
        expect(visibleWidth(lines[0]!)).toBe(expected);
        expect(visibleWidth(lines.at(-1)!)).toBe(expected);
      }
    }
  });

  test('wrapped text keeps its hanging indent instead of falling back to column 0', () => {
    const lines = hangingWrap('one two three four five six seven eight nine ten', 16, '❯ ', '  ');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]!.startsWith('❯ ')).toBe(true);
    for (const l of lines.slice(1)) expect(l.startsWith('  ')).toBe(true);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(16);
  });

  test('segments are dropped least-important first and the line never wraps', () => {
    const segs = [
      { text: 'Model', priority: 1 },
      { text: '$0.42', priority: 2 },
      { text: 'iter 3/12', priority: 5 },
      { text: '41.7 t/s', priority: 6 },
    ];
    expect(fitSegments(segs, 100, ' · ')).toBe('Model · $0.42 · iter 3/12 · 41.7 t/s');
    expect(fitSegments(segs, 22, ' · ')).toBe('Model · $0.42');
    expect(visibleWidth(fitSegments(segs, 3, ' · '))).toBeLessThanOrEqual(3);
  });

  test('the status bar is one line at every width and keeps the model name longest', () => {
    const s = new StatusBarComponent();
    s.setProvider('MiniMax · MiniMax-M2.5');
    s.setStats({ inputTokens: 128_400, outputTokens: 4_210, costUsd: 0.42, iter: 3, maxIter: 12, tokensPerSecond: 41.7 });
    for (const w of WIDTHS) {
      const lines = s.render(w);
      expect(lines.length).toBe(1);
      expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(w);
    }
    expect(plain(s.render(30)[0]!)).toContain('MiniMax');
  });

  test('a long question and answer stay aligned under their markers', () => {
    const text = 'Grade NVDA on both horizons and explain what drives the difference between them';
    const q = new UserQueryComponent(text).render(30).map(plain).filter((l) => l.trim());
    expect(q[0]!.startsWith('❯ ')).toBe(true);
    for (const l of q.slice(1)) expect(l.startsWith('  ')).toBe(true);

    const a = new AnswerBoxComponent(text).render(30).map(plain).filter((l) => l.trim());
    expect(a[0]!.startsWith('⏺ ')).toBe(true);
    for (const l of a.slice(1)) expect(l.startsWith('  ')).toBe(true);
  });

  test('the intro re-lays itself out on every size change, both directions', () => {
    const intro = new IntroComponent('minimax:MiniMax-M2.5', 'MiniMax', 15);
    for (const w of [120, 40, 100, 24, 72]) {
      for (const l of intro.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });
});
