import { logger } from '../../../utils/logger.js';
import {
  callTelegram,
  getBotInfo,
  sendMessageTelegram,
  sendTypingTelegram,
} from './api.js';
import type { TelegramInboundMessage, TelegramStatus } from './types.js';

type TelegramChat = {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
  first_name?: string;
};

type TelegramUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
};

type TelegramMessage = {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date?: number;
  text?: string;
  caption?: string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  reply_to_message?: { from?: TelegramUser };
  entities?: Array<{ type: string; offset: number; length: number }>;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

export type TelegramGroupPolicy = 'open' | 'allowlist' | 'disabled';

export type MonitorTelegramParams = {
  accountId: string;
  botToken: string;
  /** Allowed DM senders: numeric chat/user ids or @usernames. '*' allows anyone. */
  allowFrom: string[];
  groupPolicy: TelegramGroupPolicy;
  /** Allowed group chat ids/usernames when groupPolicy === 'allowlist'. */
  groupAllowFrom: string[];
  abortSignal: AbortSignal;
  onMessage: (msg: TelegramInboundMessage) => Promise<void>;
  onStatus?: (status: TelegramStatus) => void;
};

function normalizeAllowEntry(entry: string): string {
  return entry.trim().replace(/^@/, '').toLowerCase();
}

function senderMatchesAllowlist(
  allowFrom: string[],
  senderId: string,
  username?: string,
): boolean {
  const normalized = allowFrom.map(normalizeAllowEntry).filter(Boolean);
  if (normalized.includes('*')) return true;
  if (normalized.includes(senderId.toLowerCase())) return true;
  if (username && normalized.includes(username.toLowerCase())) return true;
  return false;
}

const MAX_DOCUMENT_BYTES = 2_000_000;

/** Lazily downloadable attachment: nothing is fetched unless the handler asks. */
function telegramDocument(botToken: string, doc: NonNullable<TelegramMessage['document']>) {
  return {
    fileName: doc.file_name ?? 'file',
    size: doc.file_size ?? 0,
    readText: async (): Promise<string> => {
      if ((doc.file_size ?? 0) > MAX_DOCUMENT_BYTES) throw new Error('file is larger than 2 MB');
      const file = await callTelegram<{ file_path?: string }>(botToken, 'getFile', { file_id: doc.file_id });
      if (!file.file_path) throw new Error('Telegram returned no file path');
      const res = await fetch(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`download failed (${res.status})`);
      return await res.text();
    },
  };
}

function extractText(message: TelegramMessage): string {
  return (message.text ?? message.caption ?? '').trim();
}

function detectMention(message: TelegramMessage, botUsername?: string, botId?: number): boolean {
  if (message.reply_to_message?.from?.id && botId && message.reply_to_message.from.id === botId) {
    return true;
  }
  if (!botUsername) return false;
  const text = extractText(message).toLowerCase();
  return text.includes(`@${botUsername.toLowerCase()}`);
}

/**
 * Long-poll the Telegram Bot API for inbound messages and dispatch them.
 * Resolves when the abort signal fires (graceful shutdown).
 */
export async function monitorTelegramChannel(params: MonitorTelegramParams): Promise<void> {
  const { botToken, accountId, abortSignal, onMessage, onStatus } = params;

  let botUsername: string | undefined;
  let botId: number | undefined;
  try {
    const info = await getBotInfo(botToken, abortSignal);
    botUsername = info.username;
    botId = info.id;
    logger.info(`[Telegram] connected as @${botUsername ?? info.id} (account ${accountId})`);
    onStatus?.({ connected: true, lastError: null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onStatus?.({ connected: false, lastError: message });
    throw error;
  }

  let offset = 0;
  while (!abortSignal.aborted) {
    let updates: TelegramUpdate[];
    try {
      updates = await callTelegram<TelegramUpdate[]>(
        botToken,
        'getUpdates',
        { offset, timeout: 30, allowed_updates: ['message'] },
        abortSignal,
      );
      onStatus?.({ connected: true, lastError: null });
    } catch (error) {
      if (abortSignal.aborted) break;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[Telegram] getUpdates error: ${message}`);
      onStatus?.({ connected: false, lastError: message });
      // Back off before retrying to avoid hammering the API on persistent errors.
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    for (const update of updates) {
      offset = Math.max(offset, update.update_id + 1);
      const message = update.message;
      if (!message || !message.from) continue;
      if (message.from.is_bot) continue;

      const body = extractText(message);
      // A file without a caption has no text but is still a message (broker exports).
      if (!body && !message.document) continue;

      const chat = message.chat;
      const isGroup = chat.type === 'group' || chat.type === 'supergroup';
      const senderId = String(message.from.id);
      const senderUsername = message.from.username;
      const senderName = [message.from.first_name, message.from.last_name]
        .filter(Boolean)
        .join(' ') || senderUsername || senderId;

      // --- Access control ---
      if (isGroup) {
        if (params.groupPolicy === 'disabled') continue;
        if (
          params.groupPolicy === 'allowlist' &&
          !senderMatchesAllowlist(params.groupAllowFrom, String(chat.id), chat.username)
        ) {
          continue;
        }
      } else {
        if (!senderMatchesAllowlist(params.allowFrom, senderId, senderUsername)) {
          logger.info(`[Telegram] ignoring DM from ${senderId} (not in allowFrom)`);
          continue;
        }
      }

      const mentionsBot = isGroup ? detectMention(message, botUsername, botId) : true;

      const inbound: TelegramInboundMessage = {
        updateId: update.update_id,
        messageId: message.message_id,
        accountId,
        chatId: String(chat.id),
        chatType: isGroup ? 'group' : 'direct',
        from: chat.title ?? senderName,
        senderId,
        senderName,
        senderUsername,
        body,
        document: message.document ? telegramDocument(botToken, message.document) : undefined,
        timestamp: message.date ? message.date * 1000 : Date.now(),
        mentionsBot,
        sendTyping: () => sendTypingTelegram({ botToken, chatId: chat.id }),
        reply: (text: string, reasoning?: string) =>
          sendMessageTelegram({ botToken, chatId: chat.id, text, reasoning }),
      };

      try {
        await onMessage(inbound);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Telegram] onMessage handler error: ${msg}`);
      }
    }
  }

  onStatus?.({ connected: false, lastError: null });
}
