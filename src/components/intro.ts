import type { Component } from '@mariozechner/pi-tui';
import { visibleWidth } from '@mariozechner/pi-tui';
import packageJson from '../../package.json';
import { getModelCapabilities } from '../model/capabilities.js';
import { theme } from '../theme.js';
import { BOX_MIN_WIDTH, box, hangingWrap } from './layout.js';

const BANNER = [
  '██████╗ ██╗   ██╗██████╗  ██████╗ ',
  '██╔══██╗██║   ██║██╔══██╗██╔═══██╗',
  '██████╔╝██║   ██║██████╔╝██║   ██║',
  '██╔══██╗██║   ██║██╔══██╗██║   ██║',
  '██║  ██║╚██████╔╝██████╔╝╚██████╔╝',
  '╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝ ',
];

const GUTTER = '  ';
/** Block letters plus the gutter; below this the banner is dropped, not wrapped. */
const BANNER_MIN_WIDTH = visibleWidth(BANNER[0]!) + GUTTER.length;
/** The welcome box stops growing here: wider than this it is just empty frame. */
const BOX_MAX_WIDTH = 72;
/** Label column inside the box ("mode", "data"). */
const LABEL_COL = 6;

/**
 * Opening header: banner, a welcome box with the facts that change what the
 * session will do, and two tips. Deliberately short - a splash screen that has
 * to be scrolled past is a splash screen nobody reads.
 *
 * Fully recomputed on every render. pi-tui re-renders the tree at the new width
 * after a resize, and anything laid out once and cached is what used to stay
 * wrapped after the window was widened again. Colours are read at render time
 * too, so a theme change needs no rebuild.
 */
export class IntroComponent implements Component {
  private model: string;
  private readonly providerCount: number;

  constructor(model: string, _providerName?: string, providerCount = 0) {
    this.model = model;
    this.providerCount = providerCount;
  }

  setModel(model: string) {
    this.model = model;
  }

  /** Kept for callers that re-colour on theme change; rendering is already live. */
  refresh() {}

  invalidate() {}

  render(width: number): string[] {
    const lines: string[] = [''];

    if (width >= BANNER_MIN_WIDTH) {
      for (const row of BANNER) lines.push(GUTTER + theme.bold(theme.primary(row)));
      lines.push('');
    }

    const boxWidth = Math.min(width, BOX_MAX_WIDTH);
    // Without a frame (very narrow windows) the text gets the full width back.
    const inner = boxWidth >= BOX_MIN_WIDTH ? boxWidth - 4 : boxWidth;
    const caps = getModelCapabilities(this.model);
    const row = (label: string, value: string) =>
      hangingWrap(value, inner, theme.muted(label.padEnd(LABEL_COL)), ' '.repeat(LABEL_COL)).map((raw) => ({ raw }));

    lines.push(
      ...box(
        [
          ...hangingWrap(
            `${theme.primary('✻')} ${theme.bold('Welcome to Rubo')} ${theme.muted(`v${packageJson.version}`)}`,
            inner,
            '',
            '  ',
          ).map((raw) => ({ raw })),
          ...hangingWrap(theme.muted('Financial research agent'), inner, '').map((raw) => ({ raw })),
          { raw: '' },
          ...row(
            'mode',
            caps.reasoning
              ? `${theme.accent('thinking')} ${theme.muted('· reasoning is shown, labelled, above each answer')}`
              : `${theme.muted('direct · no reasoning pass, so no thinking blocks')}`,
          ),
          ...row('data', `${theme.primaryLight(String(this.providerCount))} ${theme.muted('providers active')}`),
        ],
        width,
        BOX_MAX_WIDTH,
      ),
    );

    lines.push('');
    lines.push(
      ...hangingWrap(
        `${theme.muted('Ask a question, or')} ${theme.primaryLight('/help')} ${theme.muted('for every command.')}`,
        width,
        GUTTER,
      ),
      ...hangingWrap(
        `${theme.primaryLight('/grade AAPL')} ${theme.muted('scores a ticker on both horizons.')}`,
        width,
        GUTTER,
      ),
    );
    lines.push('');
    return lines;
  }
}
