import { createChannelManager } from './channels/manager.js';
import { createTelegramPlugin } from './channels/telegram/plugin.js';
import type { TelegramInboundMessage } from './channels/telegram/index.js';
import { resolveRoute } from './routing/resolve-route.js';
import { resolveSessionStorePath, upsertSessionMeta } from './sessions/store.js';
import { handleSessionCommand, openConversation } from './sessions/conversation.js';
import { FINANCE_COMMANDS, importFromText, runFinanceCommand } from '../commands/finance.js';
import { ensureIncomeRefreshJob } from '../income/refresh.js';
import { ensureRebalanceCheckJob } from '../rebalance/check.js';
import { loadGatewayConfig, type GatewayConfig } from './config.js';
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '../model/llm.js';
import { runAgentForMessage, isSessionRunning, enqueueForSession } from './agent-runner.js';
import { startCronRunner } from '../cron/runner.js';
import { ensureHeartbeatCronJob } from '../cron/heartbeat-migration.js';
import { appendFileSync } from 'node:fs';
import { ruboPath } from '../utils/paths.js';
import { getSetting } from '../utils/config.js';
import type { GroupContext } from '../agent/types.js';

// ponytail: lazy so $RUBO_HOME set after module load still counts.
const LOG_PATH = () => ruboPath('gateway-debug.log');
function debugLog(msg: string) {
  appendFileSync(LOG_PATH(), `${new Date().toISOString()} ${msg}\n`);
}

export type GatewayService = {
  stop: () => Promise<void>;
  snapshot: () => Record<string, { accountId: string; running: boolean; connected?: boolean }>;
};

function elide(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

export async function handleTelegramInbound(
  cfg: GatewayConfig,
  inbound: TelegramInboundMessage,
): Promise<void> {
  const bodyPreview = elide(inbound.body.replace(/\n/g, ' '), 50);
  const isGroup = inbound.chatType === 'group';
  console.log(
    `Inbound telegram ${inbound.from} (${inbound.chatType}, ${inbound.body.length} chars): "${bodyPreview}"`,
  );
  debugLog(`[telegram] handleInbound chatId=${inbound.chatId} isGroup=${isGroup}`);

  // In groups, only respond when the bot is mentioned or replied to.
  if (isGroup && !inbound.mentionsBot) {
    debugLog(`[telegram] group message without mention, skipping`);
    return;
  }

  const peerId = inbound.chatId;
  const route = resolveRoute({
    cfg,
    channel: 'telegram',
    accountId: inbound.accountId,
    peer: { kind: inbound.chatType, id: peerId },
  });

  const storePath = resolveSessionStorePath(route.agentId);
  const meta = upsertSessionMeta({
    storePath,
    sessionKey: route.sessionKey,
    channel: 'telegram',
    to: inbound.chatId,
    accountId: route.accountId,
    agentId: route.agentId,
  });
  const model = getSetting('modelId', DEFAULT_MODEL) as string;
  const conversationCtx = {
    storePath,
    sessionKey: route.sessionKey,
    activeSessionId: meta.activeSessionId,
    model,
  };

  // /new, /sessions, /resume, /session are answered here, not by the model.
  const commandReply = await handleSessionCommand(inbound.body, conversationCtx);
  if (commandReply !== null) {
    await inbound.reply(commandReply);
    return;
  }

  // A broker export sent as a file: preview the import (nothing saved until /import confirm).
  if (inbound.document) {
    const reply = /\.(csv|txt)$/i.test(inbound.document.fileName)
      ? await inbound.document.readText()
          .then((text) => importFromText(text, inbound.document!.fileName, inbound.body))
          .catch((err: unknown) => `Could not read the file: ${err instanceof Error ? err.message : String(err)}`)
      : 'Send a broker export as a .csv file.';
    await inbound.reply(reply);
    return;
  }

  // Holdings, income and rebalancing commands: answered by code, same as the CLI.
  const finance = /^\/(\w+)(?:@\S+)?(?:\s+(.*))?$/s.exec(inbound.body.trim());
  if (finance && (FINANCE_COMMANDS as readonly string[]).includes(finance[1]!.toLowerCase())) {
    const name = finance[1]!.toLowerCase();
    const args = (finance[2] ?? '').trim();
    // A file path here would point at the server's disk, not the owner's.
    const reply = name === 'import' && !/^(confirm|cancel)$/.test(args)
      ? 'Send the CSV export to this chat as a file; you will get a preview to confirm.'
      : await runFinanceCommand(name, args);
    await inbound.reply(reply ?? '');
    return;
  }

  // Keep a typing indicator alive during long agent runs.
  const TYPING_INTERVAL_MS = 5000;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const startTypingLoop = async () => {
    await inbound.sendTyping();
    typingTimer = setInterval(() => {
      void inbound.sendTyping();
    }, TYPING_INTERVAL_MS);
  };
  const stopTypingLoop = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };

  try {
    await startTypingLoop();

    const query = inbound.body;
    // `from` is the chat title for groups. No member list: Telegram does not
    // hand one to a bot without an extra API call per message.
    const groupContext: GroupContext | undefined = isGroup
      ? { groupName: inbound.from, activationMode: 'mention' }
      : undefined;
    const modelProvider = getSetting('provider', DEFAULT_PROVIDER) as string;

    if (isSessionRunning(route.sessionKey)) {
      debugLog(`[telegram] agent busy for session=${route.sessionKey}, enqueueing`);
      enqueueForSession(route.sessionKey, model, query);
      stopTypingLoop();
      return;
    }

    // Saved thread for this chat - reloaded into memory if the gateway restarted.
    const conversation = await openConversation(conversationCtx);

    debugLog(`[telegram] running agent for session=${route.sessionKey} conversation=${conversation.id}`);
    const startedAt = Date.now();
    const reply = await runAgentForMessage({
      sessionKey: route.sessionKey,
      query,
      model,
      modelProvider,
      channel: 'telegram',
      groupContext,
    });
    const answer = reply.answer;
    const reasoning = reply.reasoning;
    const durationMs = Date.now() - startedAt;

    stopTypingLoop();

    if (answer.trim()) {
      await conversation.appendTurn(query, answer.trim());
      await inbound.reply(answer.trim(), reasoning);
      console.log(`Sent telegram reply (${answer.length} chars, ${durationMs}ms)`);
    } else {
      console.log(`Agent returned empty response (${durationMs}ms)`);
    }
  } catch (err) {
    stopTypingLoop();
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${msg}`);
    debugLog(`[telegram] ERROR: ${msg}`);
  }
}

function logChannelStatus(
  channel: string,
  accountId: string,
  snap: { running: boolean; connected?: boolean; lastError?: string | null },
): void {
  const state = !snap.running
    ? `NOT RUNNING${snap.lastError ? ` (${snap.lastError})` : ''}`
    : snap.connected === false
      ? 'started, not yet connected'
      : 'connected';
  console.log(`[gateway] ${channel}:${accountId} ${state}`);
}

export async function startGateway(params: { configPath?: string } = {}): Promise<GatewayService> {
  const telegramPlugin = createTelegramPlugin({
    loadConfig: () => loadGatewayConfig(params.configPath),
    onMessage: async (inbound) => {
      const current = loadGatewayConfig(params.configPath);
      await handleTelegramInbound(current, inbound);
    },
  });
  const telegramManager = createChannelManager({
    plugin: telegramPlugin,
    loadConfig: () => loadGatewayConfig(params.configPath),
  });

  await telegramManager.startAll();

  // Report what actually came up. startAccount() swallows a channel failure
  // into an unprinted lastError, so a gateway with a dead Telegram channel
  // logged exactly the same line as a healthy one.
  // Reported after a short settle: the connection callbacks land a moment
  // after startAll() returns, so reporting immediately always says
  // "not yet connected" even on a perfectly healthy start.
  setTimeout(() => {
    for (const [id, snap] of Object.entries(telegramManager.getSnapshot())) {
      logChannelStatus('telegram', id, snap);
    }
  }, 8000).unref?.();

  ensureHeartbeatCronJob(params.configPath);
  // Nightly income refresh (reminders) and the quarterly drift check; both no-ops until holdings exist.
  ensureIncomeRefreshJob();
  ensureRebalanceCheckJob();
  const cron = startCronRunner({ configPath: params.configPath });

  return {
    stop: async () => {
      cron.stop();
      await telegramManager.stopAll();
    },
    snapshot: () => {
      const prefix = (
        channel: string,
        snap: Record<string, { accountId: string; running: boolean; connected?: boolean }>,
      ) => Object.fromEntries(Object.entries(snap).map(([k, v]) => [`${channel}:${k}`, v]));
      return prefix('telegram', telegramManager.getSnapshot());
    },
  };
}

