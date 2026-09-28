import { ProcessTerminal } from '@mariozechner/pi-tui';

/**
 * pi-tui clears on a width change with ESC[3J ESC[2J ESC[H: scrollback first,
 * then the screen. In Windows Terminal (and VTE) ESC[2J does not erase the
 * visible screen, it scrolls it into the scrollback - which was cleared a moment
 * earlier. So every resize left the previous layout sitting above the new one.
 *
 * clear(1) uses the opposite order for exactly this reason: move home, push the
 * screen out with ESC[2J, then wipe the scrollback (now holding the old screen)
 * with ESC[3J.
 */
const PI_TUI_CLEAR = '\x1b[3J\x1b[2J\x1b[H';
const CLEAR_THEN_WIPE = '\x1b[H\x1b[2J\x1b[3J';

export function fixClearOrder(data: string): string {
  return data.includes(PI_TUI_CLEAR) ? data.split(PI_TUI_CLEAR).join(CLEAR_THEN_WIPE) : data;
}

export class RuboTerminal extends ProcessTerminal {
  override write(data: string): void {
    super.write(fixClearOrder(data));
  }
}
