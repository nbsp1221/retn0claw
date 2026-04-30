import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { createTelegramFetch } from './telegram-fetch.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  extractTelegramReplyMetadata,
  isTelegramForumServiceMessage,
  resolveTelegramThreadDecision,
} from './telegram-threading.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, {});
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'rejected'; error: unknown }
> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: 'timeout' }),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'rejected', error });
      },
    );
  });
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;
  private started = false;
  private telegramFetch = createTelegramFetch();
  private botUsername: string | undefined;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  private getChatLookup():
    | ((chatId: string | number) => Promise<{ is_forum?: boolean }>)
    | undefined {
    const bot = this.bot;
    const getChat = bot?.api.getChat;
    if (!bot || typeof getChat !== 'function') return undefined;
    return getChat.bind(bot.api) as (
      chatId: string | number,
    ) => Promise<{ is_forum?: boolean }>;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const fileLookup = await withTimeout(
        this.bot.api.getFile(fileId),
        TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS,
      );
      if (!fileLookup.ok) {
        if (fileLookup.reason === 'rejected') {
          throw fileLookup.error;
        }
        logger.warn({ fileId }, 'Telegram getFile timed out');
        return null;
      }

      const file = fileLookup.value;
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const controller = new AbortController();
      const fetchLookup = await withTimeout(
        this.telegramFetch(fileUrl, { signal: controller.signal }),
        TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS,
      );
      if (!fetchLookup.ok) {
        if (fetchLookup.reason === 'rejected') {
          throw fetchLookup.error;
        }
        controller.abort();
        logger.warn({ fileId }, 'Telegram file download timed out');
        return null;
      }

      const resp = fetchLookup.value;
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const bodyLookup = await withTimeout(
        resp.arrayBuffer(),
        TELEGRAM_MEDIA_DOWNLOAD_TIMEOUT_MS,
      );
      if (!bodyLookup.ok) {
        if (bodyLookup.reason === 'rejected') {
          throw bodyLookup.error;
        }
        controller.abort();
        logger.warn({ fileId }, 'Telegram file body download timed out');
        return null;
      }

      const buffer = Buffer.from(bodyLookup.value);
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        fetch: this.telegramFetch,
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      if (isTelegramForumServiceMessage(ctx.message)) {
        logger.warn(
          {
            chatJid,
            messageId: msgId,
            threadId,
            reason: 'forum_service_message',
          },
          'Telegram service message ignored',
        );
        return;
      }

      const group = this.opts.registeredGroups()[chatJid];

      const threadDecision = await resolveTelegramThreadDecision({
        chat: ctx.chat as {
          id: string | number;
          type: string;
          is_forum?: boolean;
        },
        messageThreadId: threadId,
        isRegistered: Boolean(group),
        getChat: this.getChatLookup(),
      });

      if (!threadDecision.deliverable) {
        const logData = {
          chatJid,
          messageId: msgId,
          threadId,
          reason: threadDecision.reason,
        };
        if (threadDecision.reason === 'unregistered_chat') {
          logger.debug(
            logData,
            'Telegram threaded message from unregistered chat',
          );
        } else {
          logger.warn(logData, 'Telegram forum message ignored');
        }
        return;
      }

      if (threadDecision.diagnosticReason) {
        logger.debug(
          {
            chatJid,
            messageId: msgId,
            threadId,
            deliverable: true,
            reason: threadDecision.diagnosticReason,
          },
          'Telegram forum status lookup treated as non-forum',
        );
      }

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      const replyMetadata = extractTelegramReplyMetadata({
        replyTo: ctx.message.reply_to_message,
        botId: ctx.me?.id,
      });

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        ...replyMetadata,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Handle non-text messages: download files when possible, fall back to placeholders.
    const storeMedia = async (
      ctx: any,
      placeholder: string,
      opts?: { fileId?: string; filename?: string },
    ) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      if (isTelegramForumServiceMessage(ctx.message)) {
        logger.warn(
          {
            chatJid,
            messageId: msgId,
            threadId,
            reason: 'forum_service_message',
          },
          'Telegram service message ignored',
        );
        return;
      }

      const group = this.opts.registeredGroups()[chatJid];

      const threadDecision = await resolveTelegramThreadDecision({
        chat: ctx.chat as {
          id: string | number;
          type: string;
          is_forum?: boolean;
        },
        messageThreadId: threadId,
        isRegistered: Boolean(group),
        getChat: this.getChatLookup(),
      });

      if (!threadDecision.deliverable) {
        const logData = {
          chatJid,
          messageId: msgId,
          threadId,
          reason: threadDecision.reason,
        };
        if (threadDecision.reason === 'unregistered_chat') {
          logger.debug(
            logData,
            'Telegram threaded media from unregistered chat',
          );
        } else {
          logger.warn(logData, 'Telegram forum media ignored');
        }
        return;
      }

      if (threadDecision.diagnosticReason) {
        logger.debug(
          {
            chatJid,
            messageId: msgId,
            threadId,
            deliverable: true,
            reason: threadDecision.diagnosticReason,
          },
          'Telegram forum status lookup treated as non-forum',
        );
      }

      if (!group) return;

      const replyMetadata = extractTelegramReplyMetadata({
        replyTo: ctx.message.reply_to_message,
        botId: ctx.me?.id,
      });

      const deliver = (content: string) => {
        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender: ctx.from?.id?.toString() || '',
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          ...replyMetadata,
        });
      };

      // If we have a file_id, attempt to download after routing is confirmed.
      if (opts?.fileId) {
        const filename =
          opts.filename ||
          `${placeholder
            .replaceAll('[', '')
            .replaceAll(']', '')
            .replaceAll(' ', '')
            .toLowerCase()}_${msgId}`;
        const filePath = await this.downloadFile(
          opts.fileId,
          group.folder,
          filename,
        );
        if (filePath) {
          deliver(`${placeholder} (${filePath})${caption}`);
        } else {
          deliver(`${placeholder}${caption}`);
        }
        return;
      }

      deliver(`${placeholder}${caption}`);
    };

    this.bot.on('message:photo', async (ctx) => {
      // Telegram sends multiple sizes; last is largest
      const photos = ctx.message.photo;
      const largest = photos?.[photos.length - 1];
      await storeMedia(ctx, '[Photo]', {
        fileId: largest?.file_id,
        filename: `photo_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:video', async (ctx) => {
      await storeMedia(ctx, '[Video]', {
        fileId: ctx.message.video?.file_id,
        filename: `video_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:voice', async (ctx) => {
      await storeMedia(ctx, '[Voice message]', {
        fileId: ctx.message.voice?.file_id,
        filename: `voice_${ctx.message.message_id}`,
      });
    });
    this.bot.on('message:audio', async (ctx) => {
      const name =
        ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`;
      await storeMedia(ctx, '[Audio]', {
        fileId: ctx.message.audio?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:document', async (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      await storeMedia(ctx, `[Document: ${name}]`, {
        fileId: ctx.message.document?.file_id,
        filename: name,
      });
    });
    this.bot.on('message:sticker', async (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      await storeMedia(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', async (ctx) => {
      await storeMedia(ctx, '[Location]');
    });
    this.bot.on('message:contact', async (ctx) => {
      await storeMedia(ctx, '[Contact]');
    });

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        this.started = false;
        this.bot = null;
        reject(err);
      };

      try {
        const startResult = this.bot!.start({
          onStart: (botInfo) => {
            if (settled) return;
            settled = true;
            this.started = true;
            this.botUsername = botInfo.username;
            logger.info(
              { username: botInfo.username, id: botInfo.id },
              'Telegram bot connected',
            );
            console.log(`\n  Telegram bot: @${botInfo.username}`);
            console.log(
              `  Send /chatid to the bot to get a chat's registration ID\n`,
            );
            resolve();
          },
        });

        void Promise.resolve(startResult).catch(fail);
      } catch (err) {
        fail(err);
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  isConnected(): boolean {
    return this.bot !== null && this.started;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  getAssistantAliases(_jid: string): string[] {
    return this.botUsername ? [`@${this.botUsername}`] : [];
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      this.started = false;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
