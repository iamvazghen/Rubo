import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@mariozechner/pi-tui';
import chalk from 'chalk';

/** Shape of a color palette. Semantic colors (success/error/warning) stay
 *  consistent across themes; the brand colors (primary/accent/etc.) change. */
interface Palette {
  primary: string;
  primaryLight: string;
  success: string;
  error: string;
  warning: string;
  muted: string;
  mutedDark: string;
  accent: string;
  white: string;
  info: string;
  queryBg: string;
  border: string;
}

/** Public type — names keys used by tool icons and other theme-aware code. */
export type ThemePaletteKey =
  | 'primary'
  | 'primaryLight'
  | 'success'
  | 'error'
  | 'warning'
  | 'muted'
  | 'mutedDark'
  | 'accent'
  | 'info'
  | 'border';

export type ThemeName = 'emerald' | 'sapphire' | 'amethyst' | 'obsidian';

const PALETTES: Record<ThemeName, Palette> = {
  // Default "finance terminal" — emerald primary with a warm gold accent.
  emerald: {
    primary: '#1fb486',
    primaryLight: '#6ee7b7',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#f59e0b',
    muted: '#94a3b8',
    mutedDark: '#2b3138',
    accent: '#f4b740',
    white: '#ffffff',
    info: '#38bdf8',
    queryBg: '#1f2937',
    border: '#2b3138',
  },
  // Cool, calm blue with a cyan accent — a classic terminal look.
  sapphire: {
    primary: '#3b82f6',
    primaryLight: '#93c5fd',
    success: '#22c55e',
    error: '#ef4444',
    warning: '#fbbf24',
    muted: '#94a3b8',
    mutedDark: '#273244',
    accent: '#22d3ee',
    white: '#ffffff',
    info: '#38bdf8',
    queryBg: '#1e293b',
    border: '#273244',
  },
  // Vivid purple with a magenta accent — a bolder, high-contrast scheme.
  amethyst: {
    primary: '#a855f7',
    primaryLight: '#d8b4fe',
    success: '#34d399',
    error: '#fb7185',
    warning: '#fbbf24',
    muted: '#a1a1aa',
    mutedDark: '#3a2b4d',
    accent: '#f472b6',
    white: '#ffffff',
    info: '#c084fc',
    queryBg: '#2a1e3a',
    border: '#3a2b4d',
  },
  // Deep obsidian — black-blue with magenta accent. For late-night trading.
  obsidian: {
    primary: '#7dd3fc',
    primaryLight: '#bae6fd',
    success: '#34d399',
    error: '#fb7185',
    warning: '#fbbf24',
    muted: '#94a3b8',
    mutedDark: '#1e293b',
    accent: '#f472b6',
    white: '#f8fafc',
    info: '#38bdf8',
    queryBg: '#0b1120',
    border: '#1e293b',
  },
};

/** Ordered list for cycling + display. */
export const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'emerald', label: 'Emerald — emerald + gold (default)' },
  { name: 'sapphire', label: 'Sapphire — blue + cyan' },
  { name: 'amethyst', label: 'Amethyst — purple + magenta' },
  { name: 'obsidian', label: 'Obsidian — black + sky + magenta' },
];

const DEFAULT_THEME: ThemeName = 'emerald';

// The single mutable source of truth. Color functions below close over this, so
// reassigning `active` instantly re-colors everything on the next render — even
// references captured at construction time (e.g. the editor's border color).
let active: Palette = PALETTES[DEFAULT_THEME];
let activeName: ThemeName = DEFAULT_THEME;

// Closures read `active[key]` at call time, never capturing a fixed color.
const fg = (key: keyof Palette) => (text: string) => chalk.hex(active[key])(text);
const bg = (key: keyof Palette) => (text: string) => chalk.bgHex(active[key])(text);

export const theme = {
  primary: fg('primary'),
  primaryLight: fg('primaryLight'),
  success: fg('success'),
  error: fg('error'),
  warning: fg('warning'),
  muted: fg('muted'),
  mutedDark: fg('mutedDark'),
  accent: fg('accent'),
  white: fg('white'),
  info: fg('info'),
  queryBg: bg('queryBg'),
  border: fg('border'),
  dim: (text: string) => chalk.dim(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  underline: (text: string) => chalk.underline(text),
};

export const markdownTheme: MarkdownTheme = {
  heading: (text) => theme.bold(theme.primary(text)),
  link: (text) => theme.primaryLight(text),
  linkUrl: (text) => theme.dim(text),
  code: (text) => theme.primaryLight(text),
  codeBlock: (text) => theme.primaryLight(text),
  codeBlockBorder: (text) => theme.mutedDark(text),
  quote: (text) => theme.info(text),
  quoteBorder: (text) => theme.mutedDark(text),
  hr: (text) => theme.mutedDark(text),
  listBullet: (text) => theme.primary(text),
  bold: (text) => theme.bold(text),
  italic: (text) => chalk.italic(text),
  strikethrough: (text) => chalk.strikethrough(text),
  underline: (text) => chalk.underline(text),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text) => theme.primaryLight(text),
  selectedText: (text) => theme.bold(theme.primaryLight(text)),
  description: (text) => theme.muted(text),
  scrollInfo: (text) => theme.muted(text),
  noMatch: (text) => theme.muted(text),
};

export const editorTheme: EditorTheme = {
  borderColor: (text) => theme.border(text),
  selectList: selectListTheme,
};

/** Switch the active palette. Returns the resolved theme name. */
export function setActiveTheme(name: ThemeName): ThemeName {
  if (PALETTES[name]) {
    active = PALETTES[name];
    activeName = name;
  }
  return activeName;
}

export function getActiveTheme(): ThemeName {
  return activeName;
}
