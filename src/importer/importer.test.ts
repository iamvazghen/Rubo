import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MarketData } from '../market/yahoo.js';
import { parseBrokerExport, parseNumber } from './parse.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'rubo-import-')); process.env.RUBO_HOME = home; });
afterEach(() => { delete process.env.RUBO_HOME; rmSync(home, { recursive: true, force: true }); });

/** Shape of an IBKR Activity Statement CSV (sections, Header/Data rows). */
const IBKR = `Statement,Header,Field Name,Field Value
Statement,Data,Title,Activity Statement
Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code
Open Positions,Data,Summary,Stocks,USD,KO,100,1,55.2,5520,70,7000,1480,
Open Positions,Data,Summary,Stocks,USD,VT,12.5,1,98.4,1230,120,1500,270,
Open Positions,Total,,Stocks,USD,,,,,6750,,8500,1750,
Open Positions,Data,Summary,Forex,EUR,EUR,300,1,1,300,1,300,0,
Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,Underlying,Listing Exch,Multiplier,Type,Code
Financial Instrument Information,Data,Stocks,KO,COCA-COLA CO/THE,8894,US1912161007,KO,NYSE,1,COMMON,
Financial Instrument Information,Data,Stocks,VT,VANGUARD TOT WORLD STK ETF,52197301,US9220427424,VT,ARCA,1,ETF,
`;

/** Trade Republic style transaction list: semicolons and German decimals. */
const TR_TRANSACTIONS = `Datum;Typ;Wertpapier;ISIN;Anzahl;Kurs;Betrag;Währung
02.01.2026;Kauf;Deutsche Telekom;DE0005557508;10;28,50;-285,00;EUR
03.02.2026;Sparplan;Deutsche Telekom;DE0005557508;5;30,10;-150,50;EUR
10.03.2026;Verkauf;Deutsche Telekom;DE0005557508;3;32,00;96,00;EUR
15.04.2026;Dividende;Deutsche Telekom;DE0005557508;12;0,77;9,24;EUR
05.05.2026;Kauf;Vanguard FTSE All-World;IE00BK5BQT80;4;1.234,50;-4.938,00;EUR
`;

const market: MarketData = {
  quote: async () => null,
  dividendHistory: async () => null,
  dividendCalendar: async () => null,
  rate: async () => 1,
  fundamentals: async () => null,
  searchIsin: async (isin) => ({
    US1912161007: [{ symbol: 'KO', exchange: 'NYQ', quoteType: 'EQUITY' }],
    US9220427424: [{ symbol: 'VT', exchange: 'PCX', quoteType: 'ETF' }],
    DE0005557508: [{ symbol: 'DTE.F', exchange: 'FRA', quoteType: 'EQUITY' }, { symbol: 'DTE.DE', exchange: 'GER', quoteType: 'EQUITY' }],
    IE00BK5BQT80: [{ symbol: 'VWRA.L', exchange: 'LSE', quoteType: 'ETF' }, { symbol: 'VWCE.DE', exchange: 'GER', quoteType: 'ETF' }],
  } as Record<string, any>)[isin] ?? [],
};

describe('broker exports', () => {
  test('numbers in German and English notation', () => {
    expect(parseNumber('1.234,50')).toBe(1234.5);
    expect(parseNumber('1,234.50')).toBe(1234.5);
    expect(parseNumber('-285,00')).toBe(-285);
    expect(parseNumber('abc')).toBeNaN();
  });

  test('IBKR statement: summary rows only, cash lines skipped, ISIN and ETF type joined in', () => {
    const r = parseBrokerExport(IBKR);
    expect(r.format).toBe('IBKR Activity Statement');
    expect(r.holdings).toEqual([
      { symbol: 'KO', isin: 'US1912161007', name: 'COCA-COLA CO/THE', shares: 100, avg_cost: 55.2, currency: 'USD', asset_type: 'stock' },
      { symbol: 'VT', isin: 'US9220427424', name: 'VANGUARD TOT WORLD STK ETF', shares: 12.5, avg_cost: 98.4, currency: 'USD', asset_type: 'etf' },
    ]);
  });

  test('Trade Republic transactions become holdings with an average cost; dividends are ignored', () => {
    const r = parseBrokerExport(TR_TRANSACTIONS, 'traderepublic');
    expect(r.format).toContain('transactions');
    const dte = r.holdings.find((h) => h.isin === 'DE0005557508')!;
    expect(dte.shares).toBe(12);
    // (285 + 150.50) / 15 = 29.0333; the sale keeps the average.
    expect(dte.avg_cost).toBeCloseTo(29.0333, 4);
    expect(r.holdings.find((h) => h.isin === 'IE00BK5BQT80')).toMatchObject({ shares: 4, avg_cost: 1234.5, currency: 'EUR' });
  });

  test('preview changes nothing; confirm writes; re-import is unchanged', async () => {
    const { previewImport, confirmImport, describePreview } = await import('./apply.js');
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    const preview = await previewImport(TR_TRANSACTIONS, 'traderepublic', market);
    expect(new PortfolioStore().read().positions).toHaveLength(0);
    expect(describePreview(preview)).toContain('/import confirm');
    // EUR holdings get the Xetra listing for market data.
    expect(preview.changes.map((c) => c.position.data_symbol).sort()).toEqual(['DTE.DE', 'VWCE.DE']);

    expect(confirmImport()).toContain('Imported 2 changes');
    const saved = new PortfolioStore().read().positions;
    expect(saved.map((p) => [p.account, p.asset_type])).toEqual([['traderepublic', 'stock'], ['traderepublic', 'etf']]);

    const again = await previewImport(TR_TRANSACTIONS, 'traderepublic', market);
    expect(again.changes.every((c) => c.kind === 'unchanged')).toBe(true);
  });
});

describe('the sample files in examples/', () => {
  const read = (f: string) => readFileSync(join(import.meta.dir, '../../examples', f), 'utf8');

  test('IBKR statement: five US holdings with ISINs, cash left out', () => {
    const r = parseBrokerExport(read('ibkr-activity-statement.csv'));
    expect(r.holdings.map((h) => h.symbol)).toEqual(['KO', 'JNJ', 'O', 'MSFT', 'VT']);
    expect(r.holdings.find((h) => h.symbol === 'VT')).toMatchObject({ isin: 'US9220427424', asset_type: 'etf', shares: 40 });
  });

  test('Trade Republic transactions: buys, savings plans and a sale become holdings; dividends are skipped', () => {
    const r = parseBrokerExport(read('traderepublic-transactions.csv'));
    const dte = r.holdings.find((h) => h.isin === 'DE0005557508')!;
    expect(dte.shares).toBe(45);
    expect(dte.avg_cost).toBeCloseTo(29.1, 4); // a sale does not change the average
    expect(r.holdings.find((h) => h.isin === 'IE00B8GKDB10')!.shares).toBeCloseTo(31.4711, 4);
    expect(r.holdings).toHaveLength(5);
  });

  test('generic holdings table in several currencies', () => {
    const r = parseBrokerExport(read('holdings-generic.csv'));
    expect(r.holdings.map((h) => [h.symbol, h.currency, h.asset_type])).toEqual([
      ['NESN.SW', 'CHF', 'stock'], ['ASML.AS', 'EUR', 'stock'], ['ULVR.L', 'GBp', 'stock'], ['VGWL.DE', 'EUR', 'etf'],
    ]);
  });

  test('London pence stay pence, not pounds', async () => {
    const { previewImport } = await import('./apply.js');
    const p = await previewImport(read('holdings-generic.csv'), 'degiro', market);
    expect(p.changes.find((c) => c.position.ticker === 'ULVR.L')!.position.currency).toBe('GBp');
  });

  test('the account is named by the owner or recognised, never assumed', async () => {
    const { detectAccount } = await import('../commands/finance.js');
    expect(detectAccount('', 'ibkr-activity-statement.csv', '')).toBe('ibkr');
    expect(detectAccount('', 'export.csv', read('ibkr-activity-statement.csv'))).toBe('ibkr');
    expect(detectAccount('my Trade Republic export', 'x.csv', '')).toBe('traderepublic');
    expect(detectAccount('degiro', 'holdings-generic.csv', '')).toBe('degiro');
    expect(detectAccount('', 'holdings-generic.csv', '')).toBe('default'); // "holdings" is not ING
    expect(detectAccount('pension', 'x.csv', '')).toBe('pension');
  });
});

describe('listings from OpenFIGI', () => {
  test('exchange codes become Yahoo symbols; Frankfurt also offers the Xetra symbol', async () => {
    const { figiToListings } = await import('../market/openfigi.js');
    expect(figiToListings([
      { ticker: 'VGWD', exchCode: 'GR', securityType: 'ETP' },
      { ticker: 'VHYL', exchCode: 'NA', securityType: 'ETP' },
      { ticker: 'KO', exchCode: 'UN', securityType: 'Common Stock' },
      { ticker: 'KOEUR', exchCode: 'E1', securityType: 'Common Stock' }, // not a main venue
      { ticker: 'BRK/B', exchCode: 'UN', securityType: 'Common Stock' }, // written differently on Yahoo
    ]).map((m) => [m.symbol, m.exchange, m.quoteType])).toEqual([
      ['VGWD.F', 'FRA', 'ETF'], ['VGWD.DE', 'GER', 'ETF'], ['VHYL.AS', 'AMS', 'ETF'], ['KO', 'NYQ', 'EQUITY'],
    ]);
  });

  test('a EUR holding gets a EUR listing that really trades, not the London one', async () => {
    const { previewImport } = await import('./apply.js');
    const quoted = new Set(['VGWD.DE']);
    const figiMarket: MarketData = {
      ...market,
      quote: async (s) => (quoted.has(s) ? { price: 70, currency: 'EUR' } : null),
      searchIsin: async () => [
        { symbol: 'VHYD.L', exchange: 'LSE', quoteType: 'ETF' },
        { symbol: 'VGWD.F', exchange: 'FRA', quoteType: 'ETF', unverified: true },
        { symbol: 'VGWD.XX', exchange: 'GER', quoteType: 'ETF', unverified: true }, // no quote: skipped
        { symbol: 'VGWD.DE', exchange: 'GER', quoteType: 'ETF', unverified: true },
      ],
    };
    const csvText = 'ISIN;Anzahl;Kurs;Währung;Typ\nIE00B8GKDB10;10;65,00;EUR;ETF\n';
    const p = await previewImport(csvText, 'traderepublic', figiMarket);
    expect(p.changes[0]!.position.data_symbol).toBe('VGWD.DE');
  });
});
