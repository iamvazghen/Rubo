import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MarketData } from '../market/yahoo.js';
import type { TelegramInboundMessage } from './channels/telegram/index.js';

/**
 * The Telegram path end to end, offline: a CSV sent to the bot, the finance
 * commands, and a scheduled reminder delivered by the cron executor without a
 * model. Yahoo is replaced by a fixed market; Telegram's HTTP API by a stub.
 */
let home: string;
const sent: { method: string; payload: any }[] = [];
const realFetch = globalThis.fetch;
let yahoo: MarketData;
let saved: Partial<MarketData>;

const fake: Partial<MarketData> = {
  quote: async (s) => (s === 'KO' ? { price: 70, currency: 'USD' } : s === 'VT' ? { price: 120, currency: 'USD' } : null),
  dividendHistory: async (s) =>
    s === 'KO'
      ? { currency: 'USD', instrumentType: 'EQUITY', dividends: ['2025-12-01', '2026-03-14', '2026-06-13', '2026-09-15'].map((d) => ({ exDate: d, amount: 0.53 })) }
      : null,
  dividendCalendar: async (s) => (s === 'KO' ? { exDate: '2026-09-15', payDate: '2026-10-01', annualRate: 2.12 } : null),
  rate: async (from, to) => (from === to ? 1 : from === 'EUR' && to === 'USD' ? 1.1 : null),
  fundamentals: async () => null,
  searchIsin: async () => [],
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'rubo-tg-'));
  process.env.RUBO_HOME = home;
  process.env.RUBO_TIMEZONE = 'America/New_York';
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.TYPESAFE_API_KEY;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ method: String(url).split('/').pop()!, payload: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  ({ yahoo } = await import('../market/yahoo.js'));
  saved = { ...yahoo };
  Object.assign(yahoo, fake);
});

afterAll(() => {
  globalThis.fetch = realFetch;
  Object.assign(yahoo, saved);
  for (const k of ['RUBO_HOME', 'RUBO_TIMEZONE', 'TELEGRAM_BOT_TOKEN']) delete process.env[k];
  rmSync(home, { recursive: true, force: true });
});

const replies: string[] = [];
const inbound = (body: string, document?: TelegramInboundMessage['document']): TelegramInboundMessage => ({
  updateId: 1, messageId: 1, accountId: 'default', chatId: '4242', chatType: 'direct', from: 'Owner', senderId: '4242',
  body, document, mentionsBot: false, sendTyping: async () => {}, reply: async (text) => { replies.push(text); },
});
const say = async (body: string, document?: TelegramInboundMessage['document']) => {
  const { handleTelegramInbound } = await import('./gateway.js');
  const { loadGatewayConfig } = await import('./config.js');
  await handleTelegramInbound(loadGatewayConfig(), inbound(body, document));
  return replies.at(-1)!;
};
const csv = (name: string) => readFileSync(join(import.meta.dir, '../../examples', name), 'utf8');

describe('Telegram: import, configure, get reminded', () => {
  test('a CSV sent as a file is previewed; nothing is saved until /import confirm', async () => {
    const preview = await say('', { fileName: 'ibkr-activity-statement.csv', size: 1, readText: async () => csv('ibkr-activity-statement.csv') });
    expect(preview).toContain('account "ibkr"');
    expect(preview).toContain('+ KO (stock) 120');
    const { PortfolioStore } = await import('../tools/portfolio/store.js');
    expect(new PortfolioStore().read().positions).toHaveLength(0);
    expect(await say('/import confirm')).toContain('Imported 5 changes into ibkr');
    expect(new PortfolioStore().read().positions).toHaveLength(5);
  });

  test('other files and server paths are refused', async () => {
    expect(await say('', { fileName: 'statement.pdf', size: 1, readText: async () => '' })).toContain('.csv');
    expect(await say('/import /etc/passwd')).toContain('Send the CSV export to this chat as a file');
  });

  test('/setup and /tax are answered by code, with the bot-name suffix Telegram adds', async () => {
    expect(await say('/setup@rubo_bot')).toContain('Time zone: America/New_York');
    expect(await say('/tax set residence US')).toContain('Tax residence: US');
    expect(await say('/income refresh')).toContain('KO:2026-09-15');
  });

  test('the pay-date reminder goes out through Telegram exactly as computed, with no model', async () => {
    const { loadCronStore } = await import('../cron/store.js');
    const { refreshIncome } = await import('../income/refresh.js');
    await refreshIncome({ now: new Date('2026-09-28T12:00:00Z') });
    const store = loadCronStore();
    const job = store.jobs.find((j) => j.name === 'income:KO:2026-09-15:pay')!;
    // 10:00 in New York (EDT) is 14:00 UTC.
    expect(job.schedule).toEqual({ kind: 'at', at: '2026-10-01T14:00:00.000Z' });
    // A US resident: no withholding on a US stock, no residence rules set up -> the gross is the net.
    expect(job.payload.message).toContain('120 × 0.5300 USD = $63.60 gross');
    expect(job.payload.message).toContain('To use: $63.60');

    const { executeCronJob } = await import('../cron/executor.js');
    sent.length = 0;
    await executeCronJob(job, store, {});
    const message = sent.find((s) => s.method === 'sendMessage')!;
    expect(message.payload.chat_id).toBe('4242');
    expect(message.payload.text).toContain('$63.60 gross');
    expect(message.payload.text).toContain('/done KO:2026-09-15');
    expect(job.enabled).toBe(false); // a one-off
    expect(job.state.lastRunStatus).toBe('ok');
  });
});
