import type { Component } from '@mariozechner/pi-tui';
import { visibleWidth } from '@mariozechner/pi-tui';
import { theme } from '../theme.js';
import { hangingWrap } from './layout.js';

/**
 * The user's question, highlighted. Wrapped per render with a hanging indent so
 * a long question stays one aligned block under the ❯ at any window width.
 */
export class UserQueryComponent implements Component {
  private query = '';

  constructor(query: string) {
    this.setQuery(query);
  }

  setQuery(query: string) {
    this.query = query;
  }

  invalidate() {}

  render(width: number): string[] {
    const rows = hangingWrap(this.query, width - 1, '❯ ', '  ');
    // Pad every row to the same width so the highlight is a clean block, not a ragged edge.
    const span = Math.max(...rows.map((r) => visibleWidth(r))) + 1;
    return ['', ...rows.map((r) => theme.queryBg(theme.white(r + ' '.repeat(span - visibleWidth(r)))))];
  }
}
