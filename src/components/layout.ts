import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@mariozechner/pi-tui';
import { theme } from '../theme.js';

/**
 * Layout primitives shared by the components that must reflow on resize.
 *
 * Every function takes the width it is given on *this* render and derives the
 * layout from it. Nothing is measured once and cached, because pi-tui re-renders
 * the whole tree at the new width after a resize and a cached layout is exactly
 * what leaves a banner wrapped or a box torn after the window changes size.
 */

/**
 * Wrap `text` so every line fits `width`, with `first` in front of the first
 * line and `rest` in front of every continuation line - a hanging indent, so
 * wrapped text lines up under itself instead of falling back to column 0.
 */
export function hangingWrap(text: string, width: number, first: string, rest = ' '.repeat(visibleWidth(first))): string[] {
  const inner = Math.max(1, width - Math.max(visibleWidth(first), visibleWidth(rest)));
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    for (const line of wrapTextWithAnsi(paragraph, inner)) {
      out.push((out.length === 0 ? first : rest) + line);
    }
  }
  return out;
}

/** Narrowest window that still gets a frame; below it content is drawn bare. */
export const BOX_MIN_WIDTH = 24;

/**
 * A rounded frame that is exactly as wide as it is allowed to be: `width`,
 * capped at `maxWidth`. Content lines are wrapped to the inner width with a
 * hanging indent, so shrinking the window re-flows the text inside the frame
 * instead of breaking the frame.
 *
 * Pass `raw` lines for content that must not be re-wrapped (block banners):
 * they are clipped instead.
 */
export function box(
  content: Array<string | { raw: string }>,
  width: number,
  maxWidth = width,
): string[] {
  const w = Math.min(width, maxWidth);
  if (w < BOX_MIN_WIDTH) {
    return content.flatMap((c) =>
      typeof c === 'string' ? hangingWrap(c, w, '') : [truncateToWidth(c.raw, w, '')],
    );
  }

  const inner = w - 4; // "│ " + content + " │"
  const edge = (s: string) => theme.border(s);
  const lines = [edge(`╭${'─'.repeat(w - 2)}╮`)];
  for (const c of content) {
    const rows = typeof c === 'string' ? hangingWrap(c, inner, '') : [truncateToWidth(c.raw, inner, '')];
    for (const row of rows) {
      const pad = Math.max(0, inner - visibleWidth(row));
      lines.push(`${edge('│')} ${row}${' '.repeat(pad)} ${edge('│')}`);
    }
  }
  lines.push(edge(`╰${'─'.repeat(w - 2)}╯`));
  return lines;
}

export interface Segment {
  text: string;
  /** Lower survives longer. The segment with the highest number is dropped first. */
  priority: number;
}

/**
 * Join segments on one line, dropping the least important ones until the line
 * fits `width`. Order on screen is preserved. A status line that wraps pushes
 * everything under it down a row and makes the editor jump, so it never wraps:
 * if even the most important segment is too wide, it is truncated.
 */
export function fitSegments(segments: Segment[], width: number, sep: string): string {
  let kept = segments.filter((s) => s.text.length > 0);
  const joined = () => kept.map((s) => s.text).join(sep);
  while (kept.length > 1 && visibleWidth(joined()) > width) {
    const worst = kept.reduce((a, b) => (b.priority > a.priority ? b : a));
    kept = kept.filter((s) => s !== worst);
  }
  return truncateToWidth(joined(), width, '…');
}
