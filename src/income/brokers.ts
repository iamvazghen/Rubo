import type { AccountTax } from './tax.js';

/**
 * Known brokers and the country they operate from. Only used to guess a new
 * account's defaults (is it domestic for the owner?); every value can be
 * changed with /tax. An account can have any name - unknown brokers work too.
 */
export interface Broker {
  name: string;
  country: string;
}

export const BROKERS: Record<string, Broker> = {
  traderepublic: { name: 'Trade Republic', country: 'DE' },
  scalable: { name: 'Scalable Capital', country: 'DE' },
  comdirect: { name: 'comdirect', country: 'DE' },
  consorsbank: { name: 'Consorsbank', country: 'DE' },
  flatex: { name: 'flatex', country: 'DE' },
  ing: { name: 'ING', country: 'DE' },
  dkb: { name: 'DKB', country: 'DE' },
  degiro: { name: 'DEGIRO', country: 'NL' },
  ibkr: { name: 'Interactive Brokers', country: 'US' },
  schwab: { name: 'Charles Schwab', country: 'US' },
  fidelity: { name: 'Fidelity', country: 'US' },
  vanguard: { name: 'Vanguard', country: 'US' },
  trading212: { name: 'Trading 212', country: 'GB' },
  flatexat: { name: 'flatex Austria', country: 'AT' },
};

/** "Trade Republic", "trade-republic", "TR" → traderepublic; unknown names stay as given (lower-cased). */
export function accountId(name: string): string {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const aliases: Record<string, string> = { tr: 'traderepublic', interactivebrokers: 'ibkr', ib: 'ibkr', scalablecapital: 'scalable' };
  return aliases[key] ?? (key || 'default');
}

/** Defaults for an account seen for the first time. W-8BEN is not assumed: confirm it with /tax. */
export function defaultAccountTax(account: string, residence: string | null): AccountTax {
  const broker = BROKERS[account];
  return {
    broker: broker ? account : undefined,
    domestic: Boolean(broker && residence && broker.country === residence),
    w8ben: false,
    allowance_assigned: 0,
  };
}
