/**
 * Persistent status footer. Renders a single line summarizing the active
 * model, current-turn token usage + cost estimate, iteration count, and
 * tokens/second throughput. Updates whenever the underlying stats change.
 *
 * Wiring (in cli.ts):
 *   statusBar.setProvider(`OpenAI · gpt-5.5`);
 *   statusBar.setStats({ inputTokens, outputTokens, totalTokens, costUsd, iter, maxIter, tps });
 */
import { Container, Text } from '@mariozechner/pi-tui';
import { theme } from '../theme.js';
import { formatTokensCompact } from '../utils/format.js';
import { formatUsd } from '../utils/cost.js';
import { fitSegments, type Segment } from './layout.js';
import { getModelCapabilities } from '../model/capabilities.js';

export interface StatusStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  iter: number;
  maxIter: number;
  tokensPerSecond: number | null;
}

export class StatusBarComponent extends Container {
  private readonly summaryText: Text;
  private providerLabel = '';
  private modelId = '';
  private stats: StatusStats | null = null;
  private lastRendered = '';
  private segments: Segment[] = [];

  constructor() {
    super();
    this.summaryText = new Text('', 0, 0);
    this.addChild(this.summaryText);
  }

  setProvider(label: string) {
    this.providerLabel = label;
    this.refresh();
  }

  /**
   * The model in use, so the bar can show whether it is a thinking model.
   * Knowing this up front matters: it tells the user whether to expect
   * reasoning blocks at all, rather than wondering why they never appear.
   */
  setModel(model: string) {
    this.modelId = model;
    this.refresh();
  }

  setStats(stats: StatusStats | null) {
    this.stats = stats;
    this.refresh();
  }

  private refresh() {
    if (!this.providerLabel && !this.stats && !this.modelId) {
      this.summaryText.setText('');
      this.lastRendered = '';
      this.segments = [];
      return;
    }

    // Priority decides what survives a narrow window: lower numbers stay longest.
    const parts: Segment[] = [];
    if (this.providerLabel) parts.push({ text: theme.primary(this.providerLabel), priority: 1 });

    if (this.modelId) {
      const caps = getModelCapabilities(this.modelId);
      // Dim for a plain model, accented for a thinking one - the badge is
      // meant to be readable at a glance, not to compete with the numbers.
      parts.push({ text: caps.reasoning ? theme.accent(caps.label) : theme.muted(caps.label), priority: 4 });
    }

    // Suppress the whole stats group until something has actually run:
    // zeros are noise, and noise next to live numbers makes both harder to read.
    const hasActivity =
      this.stats != null &&
      (this.stats.inputTokens > 0 || this.stats.outputTokens > 0 || this.stats.iter > 0);

    if (this.stats && hasActivity) {
      const { inputTokens, outputTokens, costUsd, iter, maxIter, tokensPerSecond } = this.stats;
      const tokenLine = `${theme.muted('↓')}${formatTokensCompact(inputTokens)} ${theme.muted('↑')}${formatTokensCompact(outputTokens)}`;
      parts.push({ text: theme.muted(tokenLine), priority: 3 });
      parts.push({ text: theme.warning(formatUsd(costUsd)), priority: 2 });
      parts.push({ text: theme.muted(`iter ${iter}/${maxIter}`), priority: 5 });
      if (tokensPerSecond != null) parts.push({ text: theme.info(`${formatTokensCompact(tokensPerSecond)} t/s`), priority: 6 });
    }

    this.segments = parts;
    this.lastRendered = parts.map((p) => p.text).join(theme.muted(' · '));
    this.summaryText.setText(this.lastRendered);
  }

  /**
   * Always exactly one line. A wrapping status bar pushes the editor down a row
   * and makes it jump on every resize, so segments are dropped (least important
   * first) until the line fits the window it is drawn in.
   */
  render(width: number): string[] {
    if (this.segments.length === 0) return [];
    return [fitSegments(this.segments, width, theme.muted(' · '))];
  }
}
