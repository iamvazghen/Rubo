import { getSetting } from './config.js';

/**
 * Per-user locale. Nothing here assumes where the owner lives: each value is a
 * setting (`/setup`), then an environment variable, then a neutral default.
 */

/** IANA time zone for session ids and reminder times. Default: this machine's. */
export function timeZone(): string {
  return (
    getSetting<string>('timezone', '') ||
    process.env.RUBO_TIMEZONE ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  );
}

/** Currency every portfolio and income amount is reported in. Default: USD. */
export function baseCurrency(): string {
  return (getSetting<string>('base_currency', '') || process.env.RUBO_BASE_CURRENCY || 'USD').toUpperCase();
}

const SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF ', CAD: 'C$', AUD: 'A$' };

/** `$53.00`, `€53.00`, `53.00 SEK` - in the base currency unless told otherwise. */
export function money(amount: number, currency = baseCurrency()): string {
  const sign = amount < 0 ? '−' : '';
  const abs = Math.abs(amount).toFixed(2);
  const symbol = SYMBOLS[currency];
  return symbol ? `${sign}${symbol}${abs}` : `${sign}${abs} ${currency}`;
}
