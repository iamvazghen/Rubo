import { describe, test, expect } from 'bun:test';
import { HelpPanelComponent } from './help-panel.js';
import { ThinkingBlockComponent } from './thinking-block.js';
import { IntroComponent } from './intro.js';
import { WatchlistComponent } from './watchlist.js';
import { StatusBarComponent } from './status-bar.js';
import { SLASH_COMMANDS } from '../commands/index.js';
import { setActiveTheme } from '../theme.js';

/** Flatten a component tree into the text it would print. */
function renderedText(component: { render: (width: number) => string[] }): string {
  return component.render(120).join('\n');
}

describe('help panel', () => {
  test('lists every registered command', () => {
    // The old hand-written help omitted seven commands. This makes that
    // impossible to repeat without a failing test.
    const text = renderedText(new HelpPanelComponent());
    for (const cmd of SLASH_COMMANDS) {
      expect(text).toContain(`/${cmd.name}`);
    }
  });

  test('shows category headings and key bindings', () => {
    const text = renderedText(new HelpPanelComponent());
    expect(text).toContain('Research');
    expect(text).toContain('Commands');
    expect(text).toContain('Keys');
    expect(text).toContain('ctrl+p');
  });
});

describe('thinking block', () => {
  test('renders the label, the model and the reasoning', () => {
    const text = renderedText(new ThinkingBlockComponent('Weighing ROIC.', 'minimax-m2.5'));
    expect(text).toContain('Thinking');
    expect(text).toContain('minimax-m2.5');
    expect(text).toContain('Weighing ROIC.');
  });

  test('renders nothing at all for empty reasoning', () => {
    // A non-thinking model must not produce an empty bordered box.
    expect(renderedText(new ThinkingBlockComponent('')).trim()).toBe('');
  });

  test('clips long reasoning instead of burying the conversation', () => {
    const long = Array.from({ length: 40 }, (_, i) => `thought ${i}`).join('\n');
    const text = renderedText(new ThinkingBlockComponent(long));
    expect(text).toContain('more line');
    expect(text.split('\n').length).toBeLessThan(15);
  });
});

describe('intro header', () => {
  test('names the model and flags a thinking model', () => {
    const text = renderedText(new IntroComponent('minimax:MiniMax-M2.5', 'MiniMax'));
    expect(text).toContain('thinking');
    expect(text).toContain('/help');
  });

  test('a non-reasoning model is shown as direct', () => {
    const text = renderedText(new IntroComponent('gpt-4o', 'OpenAI'));
    expect(text).toContain('direct');
  });

  test('survives a theme switch', () => {
    // Panels are colored at build time, so a theme change must rebuild them.
    for (const name of ['emerald', 'sapphire', 'amethyst', 'obsidian'] as const) {
      setActiveTheme(name);
      const intro = new IntroComponent('minimax:MiniMax-M2.5', 'MiniMax');
      intro.refresh();
      expect(renderedText(intro).length).toBeGreaterThan(0);
      const help = new HelpPanelComponent();
      help.refresh();
      expect(renderedText(help)).toContain('/grade');
    }
    setActiveTheme('emerald');
  });
});

describe('startup noise', () => {
  test('an empty watchlist renders nothing at all', () => {
    // It used to draw a bordered box with a header and a hint around no data,
    // on every single startup.
    const wl = new WatchlistComponent();
    expect(renderedText(wl).trim()).toBe('');
  });

  test('a populated watchlist still renders', () => {
    const wl = new WatchlistComponent();
    wl.setTickers(['AAPL']);
    expect(renderedText(wl)).toContain('AAPL');
  });

  test('the status bar hides zeroed stats before the first turn', () => {
    const bar = new StatusBarComponent();
    bar.setProvider('minimax · MiniMax-M2.5');
    bar.setModel('minimax:MiniMax-M2.5');
    bar.setStats({ inputTokens: 0, outputTokens: 0, costUsd: 0, iter: 0, maxIter: 20, tokensPerSecond: null });
    const text = renderedText(bar);
    expect(text).not.toContain('$0.0000');
    expect(text).not.toContain('iter 0/20');
    // The model and its capability badge stay - those are always meaningful.
    expect(text).toContain('thinking');
  });

  test('the status bar shows stats once a turn has run', () => {
    const bar = new StatusBarComponent();
    bar.setProvider('minimax · MiniMax-M2.5');
    bar.setStats({ inputTokens: 1200, outputTokens: 340, costUsd: 0.012, iter: 2, maxIter: 20, tokensPerSecond: 41 });
    const text = renderedText(bar);
    expect(text).toContain('iter 2/20');
  });

  test('the intro no longer repeats the model shown in the status bar', () => {
    const text = renderedText(new IntroComponent('minimax:MiniMax-M2.5', 'MiniMax', 12));
    expect(text).not.toContain('MiniMax-M2.5');
    expect(text).toContain('providers active');
  });
});

describe('responsive layout', () => {
  test('the block banner is dropped when the terminal is too narrow for it', () => {
    // 36 columns of block letters wrap into rubble on a narrow window.
    const wide = renderedText(new IntroComponent('gpt-4o', 'OpenAI', 3));
    expect(wide).toContain('█');

    const narrow = new IntroComponent('gpt-4o', 'OpenAI', 3);
    const narrowText = narrow.render(30).join('\n');
    expect(narrowText).not.toContain('█');
    // The name stays on screen, in the welcome box.
    expect(narrowText).toContain('Rubo');
  });

  test('a very narrow terminal drops the wordmark too but keeps the facts', () => {
    const tiny = new IntroComponent('minimax:MiniMax-M2.5', 'MiniMax', 3).render(28).join('\n');
    expect(tiny).not.toContain('█');
    expect(tiny).toContain('thinking');
  });

  test('help stacks the description under the command on a narrow terminal', () => {
    const panel = new HelpPanelComponent();
    const narrow = panel.render(50).join('\n');
    // Command and description end up on separate lines rather than truncated.
    const lines = narrow.split('\n');
    const idx = lines.findIndex((l) => l.includes('/grade AAPL'));
    expect(idx).toBeGreaterThan(-1);
    expect(lines[idx + 1]).toContain('Score a ticker');
  });

  test('help returns to one line per command when there is room', () => {
    const panel = new HelpPanelComponent();
    const wide = panel.render(120).join('\n');
    const line = wide.split('\n').find((l) => l.includes('/grade AAPL'));
    expect(line).toContain('Score a ticker');
  });

  test('widening the terminal restores the full banner', () => {
    // The bug this guards: layout is decided at build time, so without a
    // rebuild the banner stays collapsed after the window grows.
    const intro = new IntroComponent('gpt-4o', 'OpenAI', 3);
    expect(intro.render(30).join('\n')).not.toContain('█');
    expect(intro.render(120).join('\n')).toContain('█');
    // ...and shrinking again drops it again instead of keeping the wide layout.
    expect(intro.render(30).join('\n')).not.toContain('█');
  });
});
