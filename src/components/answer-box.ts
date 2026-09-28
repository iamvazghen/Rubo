import { Container, Markdown, Spacer } from '@mariozechner/pi-tui';
import type { Component } from '@mariozechner/pi-tui';
import { formatResponse } from '../utils/markdown-table.js';
import { markdownTheme, theme } from '../theme.js';
import { SourceChipsComponent } from './source-chips.js';

/**
 * Markdown indented by two columns, with the ⏺ marker drawn into the gutter of
 * the first line. The marker used to be part of the text, so every wrapped line
 * fell back to column 0 under it; indenting the whole block keeps the answer
 * aligned at any window width.
 */
class MarkedMarkdown implements Component {
  constructor(private readonly md: Markdown) {}

  invalidate() {
    this.md.invalidate?.();
  }

  render(width: number): string[] {
    const lines = this.md.render(width);
    const first = lines.findIndex((l) => l.trim().length > 0);
    if (first >= 0 && lines[first]!.startsWith('  ')) {
      lines[first] = theme.primary('⏺ ') + lines[first]!.slice(2);
    }
    return lines;
  }
}

export class AnswerBoxComponent extends Container {
  private readonly body: Markdown;
  private value = '';

  constructor(initialText = '') {
    super();
    this.addChild(new Spacer(1));
    this.body = new Markdown('', 2, 0, markdownTheme, { color: (line) => line });
    this.addChild(new MarkedMarkdown(this.body));
    this.setText(initialText);
  }

  setText(text: string) {
    this.value = text;
    const rendered = formatResponse(text);
    // Leading blank lines would put the marker's line above the first words.
    this.body.setText(rendered.replace(/^\n+/, ''));
  }

  /**
   * Append a streaming chunk to the live answer. The Markdown widget is a
   * fully-rendered tree (not a streaming renderer), so we rebuild on each
   * chunk. Throttled to ~10fps by the caller to avoid thrash. After the
   * stream ends, `setText` is called with the final value to normalize.
   */
  appendChunk(delta: string) {
    this.value += delta;
    this.setText(this.value);
  }

  appendSources(urls: ReadonlyArray<string>) {
    if (urls.length === 0) return;
    this.addChild(new SourceChipsComponent(urls));
  }
}
