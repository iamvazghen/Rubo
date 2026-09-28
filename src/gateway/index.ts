#!/usr/bin/env tsx
// Load .env first: the gateway is a separate entrypoint from the CLI, and it
// only picked up environment variables when some transitive import happened to
// pull in a module that loaded dotenv as a side effect. Run as a service, that
// is the difference between every API key being present and none of them.
import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import {
  loadGatewayConfig,
  saveGatewayConfig,
  getGatewayConfigPath,
  type GatewayConfig,
} from './config.js';
import { getBotInfo } from './channels/telegram/index.js';
import { startGateway } from './gateway.js';

async function promptTelegramSetup(cfg: GatewayConfig): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('');
    console.log('Telegram setup — create a bot with @BotFather and paste its token below.');
    const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
    let token = '';
    while (!token) {
      const prompt = envToken
        ? `Bot token [press Enter to use TELEGRAM_BOT_TOKEN]: `
        : 'Bot token: ';
      const input = (await rl.question(prompt)).trim();
      token = input || envToken || '';
      if (!token) console.log('A bot token is required.');
    }

    // Validate the token before persisting.
    try {
      const info = await getBotInfo(token);
      console.log(`Connected to @${info.username ?? info.id}.`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`Could not validate token: ${msg}`);
      return false;
    }

    console.log('');
    console.log('Who may DM the bot? Enter Telegram numeric user id(s) or @username(s),');
    console.log('comma-separated, or * to allow anyone.');
    let allowFrom: string[] = [];
    while (allowFrom.length === 0) {
      const input = (await rl.question('Allowed sender(s): ')).trim();
      if (!input) continue;
      allowFrom = input === '*' ? ['*'] : input.split(',').map((s) => s.trim()).filter(Boolean);
    }

    const accountId = cfg.gateway.accountId ?? 'default';
    cfg.channels.telegram.enabled = true;
    cfg.channels.telegram.accounts[accountId] = {
      enabled: true,
      botToken: token,
      allowFrom,
      groupPolicy: 'disabled',
      groupAllowFrom: [],
    };
    cfg.channels.telegram.allowFrom = allowFrom;
    return true;
  } finally {
    rl.close();
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'run';

  if (command === 'telegram') {
    const cfg = loadGatewayConfig();
    const ok = await promptTelegramSetup(cfg);
    if (ok) {
      const configPath = getGatewayConfigPath();
      saveGatewayConfig(cfg);
      console.log(`Saved gateway config to ${configPath}`);
      console.log('Run `npm run gateway` to start receiving Telegram messages.');
    }
    return;
  }

  const server = await startGateway();
  console.log('Rubo gateway running. Press Ctrl+C to stop.');

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void run();

