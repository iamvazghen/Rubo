import { describe, expect, test } from 'bun:test';
import { fixClearOrder } from './terminal.js';

describe('resize redraw', () => {
  test('clears the screen before wiping scrollback, so the old layout cannot survive above the new one', () => {
    const out = fixClearOrder('\x1b[?2026h\x1b[3J\x1b[2J\x1b[Hline one\r\nline two\x1b[?2026l');
    expect(out).toBe('\x1b[?2026h\x1b[H\x1b[2J\x1b[3Jline one\r\nline two\x1b[?2026l');
    // ESC[3J must come after ESC[2J: in Windows Terminal ESC[2J scrolls the screen into scrollback.
    expect(out.indexOf('\x1b[3J')).toBeGreaterThan(out.indexOf('\x1b[2J'));
  });

  test('ordinary output passes through untouched', () => {
    expect(fixClearOrder('hello\r\n')).toBe('hello\r\n');
  });
});
