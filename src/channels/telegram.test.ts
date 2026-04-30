import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader (used by the factory, not needed in unit tests)
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock group-folder (used by downloadFile)
vi.mock('../group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/test-groups/${folder}`,
  ),
}));

// --- Grammy mock ---

type Handler = (...args: any[]) => any;

const botRef = vi.hoisted(() => ({ current: null as any }));
const telegramStartErrorRef = vi.hoisted(() => ({
  current: null as Error | null,
}));
const undiciFetchRef = vi.hoisted(() => ({
  current: vi.fn(),
}));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    commandHandlers = new Map<string, Handler>();
    filterHandlers = new Map<string, Handler[]>();
    errorHandler: Handler | null = null;

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      getChat: vi.fn().mockResolvedValue({ is_forum: false }),
    };

    constructor(token: string) {
      this.token = token;
      botRef.current = this;
    }

    command(name: string, handler: Handler) {
      this.commandHandlers.set(name, handler);
    }

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(handler: Handler) {
      this.errorHandler = handler;
    }

    start(opts: { onStart: (botInfo: any) => void }) {
      if (telegramStartErrorRef.current) {
        throw telegramStartErrorRef.current;
      }
      opts.onStart({ username: 'andy_ai_bot', id: 12345 });
    }

    stop() {}
  },
}));

vi.mock('undici', () => ({
  Agent: class MockAgent {
    constructor(_options: unknown) {}
  },
  fetch: undiciFetchRef.current,
}));

import fs from 'fs';
import { TelegramChannel, TelegramChannelOpts } from './telegram.js';
import { logger } from '../logger.js';
import {
  _closeDatabase,
  _initTestDatabase,
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from '../db.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TelegramChannelOpts>,
): TelegramChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'tg:100200300': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function createTextCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  isForum?: boolean;
  text: string;
  fromId?: number;
  firstName?: string;
  username?: string;
  messageId?: number;
  date?: number;
  entities?: any[];
  reply_to_message?: any;
  message_thread_id?: number;
  me?: { id?: number; username?: string };
}) {
  const chatId = overrides.chatId ?? 100200300;
  const chatType = overrides.chatType ?? 'group';
  return {
    chat: {
      id: chatId,
      type: chatType,
      title: overrides.chatTitle ?? 'Test Group',
      ...(overrides.isForum === undefined
        ? {}
        : { is_forum: overrides.isForum }),
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: overrides.username ?? 'alice_user',
    },
    message: {
      text: overrides.text,
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      entities: overrides.entities ?? [],
      reply_to_message: overrides.reply_to_message,
      message_thread_id: overrides.message_thread_id,
    },
    me: overrides.me ?? { id: 12345, username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

function createMediaCtx(overrides: {
  chatId?: number;
  chatType?: string;
  chatTitle?: string;
  isForum?: boolean;
  fromId?: number;
  firstName?: string;
  date?: number;
  messageId?: number;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: any;
  me?: { id?: number; username?: string };
  extra?: Record<string, any>;
}) {
  const chatId = overrides.chatId ?? 100200300;
  return {
    chat: {
      id: chatId,
      type: overrides.chatType ?? 'group',
      title: overrides.chatTitle ?? 'Test Group',
      ...(overrides.isForum === undefined
        ? {}
        : { is_forum: overrides.isForum }),
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      date: overrides.date ?? Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption,
      message_thread_id: overrides.message_thread_id,
      reply_to_message: overrides.reply_to_message,
      ...(overrides.extra || {}),
    },
    me: overrides.me ?? { id: 12345, username: 'andy_ai_bot' },
  };
}

function currentBot() {
  return botRef.current;
}

async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}

async function triggerMediaMessage(
  filter: string,
  ctx: ReturnType<typeof createMediaCtx>,
) {
  const handlers = currentBot().filterHandlers.get(filter) || [];
  for (const h of handlers) await h(ctx);
}

// --- Tests ---

// Helper: flush pending microtasks (for async downloadFile().then() chains)
const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TelegramChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    telegramStartErrorRef.current = null;

    // Mock fs operations used by downloadFile
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    // Mock global fetch for file downloads
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
      }),
    );
    undiciFetchRef.current.mockResolvedValue({
      ok: true,
      arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when bot starts', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('registers command and message handlers on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().commandHandlers.has('chatid')).toBe(true);
      expect(currentBot().commandHandlers.has('ping')).toBe(true);
      expect(currentBot().filterHandlers.has('message:text')).toBe(true);
      expect(currentBot().filterHandlers.has('message:photo')).toBe(true);
      expect(currentBot().filterHandlers.has('message:video')).toBe(true);
      expect(currentBot().filterHandlers.has('message:voice')).toBe(true);
      expect(currentBot().filterHandlers.has('message:audio')).toBe(true);
      expect(currentBot().filterHandlers.has('message:document')).toBe(true);
      expect(currentBot().filterHandlers.has('message:sticker')).toBe(true);
      expect(currentBot().filterHandlers.has('message:location')).toBe(true);
      expect(currentBot().filterHandlers.has('message:contact')).toBe(true);
    });

    it('registers error handler on connect', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();

      expect(currentBot().errorHandler).not.toBeNull();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('rejects connect() when bot startup throws', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      telegramStartErrorRef.current = new Error('startup failed');

      await expect(channel.connect()).rejects.toThrow('startup failed');
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hello everyone' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          id: '1',
          chat_jid: 'tg:100200300',
          sender: '99001',
          sender_name: 'Alice',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ chatId: 999999, text: 'Unknown chat' });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        'Test Group',
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers regular group thread messages instead of dropping them', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Thread reply',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Thread reply',
        }),
      );
    });

    it('delivers confirmed non-forum supergroup thread messages', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'supergroup',
        isForum: false,
        text: 'Non-forum supergroup reply',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Non-forum supergroup reply',
        }),
      );
      expect(currentBot().api.getChat).not.toHaveBeenCalled();
    });

    it('rejects confirmed forum topic text messages in Phase 1', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'supergroup',
        isForum: true,
        text: 'Forum topic text',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:100200300',
          threadId: 42,
          reason: 'forum_topic_unsupported',
        }),
        expect.any(String),
      );
    });

    it('ignores inbound text forum service updates without getChat or delivery', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: '',
        message_thread_id: 42,
      });
      (ctx.message as any).forum_topic_created = {};
      await triggerTextMessage(ctx);

      expect(currentBot().api.getChat).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:100200300',
          messageId: '1',
          threadId: 42,
          reason: 'forum_service_message',
        }),
        'Telegram service message ignored',
      );
    });

    it('rejects confirmed forum General topic text messages in Phase 1', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'supergroup',
        isForum: true,
        text: 'Forum General topic text',
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:100200300',
          reason: 'forum_topic_unsupported',
        }),
        'Telegram forum message ignored',
      );
    });

    it('uses getChat to reject missing-status supergroup messages without thread id when they are forum General topic traffic', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({ is_forum: true });
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Forum General topic without inline status',
      });
      await triggerTextMessage(ctx);

      expect(currentBot().api.getChat).toHaveBeenCalledWith(100200300);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:100200300',
          threadId: undefined,
          reason: 'forum_topic_unsupported',
        }),
        'Telegram forum message ignored',
      );
    });

    it('delivers missing-status supergroup messages without thread id when getChat omits optional is_forum', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({
        id: 100200300,
        type: 'supergroup',
        title: 'Test Group',
      });
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Normal supergroup message without inline status',
      });
      await triggerTextMessage(ctx);

      expect(currentBot().api.getChat).toHaveBeenCalledWith(100200300);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Normal supergroup message without inline status',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_missing_treated_as_non_forum',
          threadId: undefined,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('uses getChat to confirm missing-status supergroup threads before delivering', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({ is_forum: false });
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Missing status but non-forum',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(currentBot().api.getChat).toHaveBeenCalledWith(100200300);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Missing status but non-forum',
        }),
      );
    });

    it('rejects missing-status supergroup threads when getChat confirms forum', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({ is_forum: true });
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Actually forum',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_topic_unsupported',
        }),
        expect.any(String),
      );
    });

    it('delivers missing-status supergroup threads when getChat fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockRejectedValueOnce(new Error('network down'));
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Do not leak me',
        reply_to_message: {
          message_id: 88,
          text: 'Do not log quoted text',
          from: { id: 12345, first_name: 'Andy' },
        },
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Do not leak me',
        }),
      );
      for (const [logData] of vi.mocked(logger.debug).mock.calls) {
        const serialized = JSON.stringify(logData);
        expect(serialized).not.toContain('Do not leak me');
        expect(serialized).not.toContain('Do not log quoted text');
        expect(serialized).not.toContain('reply_to_message_content');
        expect(serialized).not.toContain('replyToContent');
        expect(serialized).not.toContain('caption');
      }
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_failed_treated_as_non_forum',
          chatJid: 'tg:100200300',
          messageId: '1',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'forum_status_lookup_failed' }),
        'Telegram forum message ignored',
      );
    });

    it('delivers missing-status supergroup threads when getChat is unavailable', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      (currentBot().api as { getChat?: unknown }).getChat = undefined;
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'No getChat support',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'No getChat support',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_unavailable_treated_as_non_forum',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('delivers missing-status supergroup threads when getChat is rate limited', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockRejectedValueOnce({ error_code: 429 });
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Rate limited',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Rate limited',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_rate_limited_treated_as_non_forum',
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('delivers missing-status supergroup threads when getChat times out', async () => {
      vi.useFakeTimers();
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Timeout',
        message_thread_id: 42,
      });
      const pending = triggerTextMessage(ctx);

      await vi.advanceTimersByTimeAsync(1501);
      await pending;

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: 'Timeout',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_timeout_treated_as_non_forum',
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('does not call getChat for unregistered ambiguous thread messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        chatType: 'supergroup',
        text: 'Unknown chat',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(currentBot().api.getChat).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('delivers reply-to-bot in a regular group thread', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '이어서 설명해줘',
        message_thread_id: 42,
        reply_to_message: {
          message_id: 77,
          text: 'Bot answer',
          from: { id: 12345, first_name: 'Andy' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '77',
          reply_to_message_content: 'Bot answer',
          reply_to_sender_name: 'Andy',
          reply_to_is_bot: true,
        }),
      );
    });

    it('delivers reply-to-human in a regular group thread without implicit addressing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '사람에게 답장',
        message_thread_id: 42,
        reply_to_message: {
          message_id: 78,
          text: 'Human note',
          from: { id: 777, first_name: 'Bob' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '78',
          reply_to_message_content: 'Human note',
          reply_to_sender_name: 'Bob',
          reply_to_is_bot: false,
        }),
      );
    });

    it('does not emit the old forum-topic warning for regular group replies', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Thread reply',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(logger.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'Telegram forum topics are not supported yet; ignoring topic message',
      );
    });

    it('stores adapter-delivered missing-status supergroup reply-to-bot messages in SQLite', async () => {
      _initTestDatabase();
      try {
        const opts = createTestOpts({
          onMessage: vi.fn((_chatJid, message) => storeMessage(message)),
          onChatMetadata: vi.fn((chatJid, timestamp, name, channel, isGroup) =>
            storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
          ),
        });
        const channel = new TelegramChannel('test-token', opts);
        await channel.connect();

        currentBot().api.getChat.mockResolvedValueOnce({
          id: 100200300,
          type: 'supergroup',
          title: '루나방',
        });
        const ctx = createTextCtx({
          chatType: 'supergroup',
          text: '이어서 설명해줘',
          message_thread_id: 42,
          reply_to_message: {
            message_id: 77,
            text: 'Bot answer',
            from: { id: 12345, first_name: 'Andy' },
          },
        });
        await triggerTextMessage(ctx);

        const messages = getMessagesSince(
          'tg:100200300',
          '2024-01-01T00:00:00.000Z',
          'Andy',
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          id: '1',
          chat_jid: 'tg:100200300',
          content: '이어서 설명해줘',
          reply_to_message_id: '77',
          reply_to_message_content: 'Bot answer',
          reply_to_sender_name: 'Andy',
          reply_to_is_bot: true,
        });
        expect(messages[0].chat_jid).not.toContain('thread');
      } finally {
        _closeDatabase();
      }
    });

    it('skips bot commands (/chatid, /ping) but passes other / messages through when thread id is present', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Bot commands should be skipped
      const ctx1 = createTextCtx({ text: '/chatid', message_thread_id: 42 });
      await triggerTextMessage(ctx1);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      const ctx2 = createTextCtx({ text: '/ping', message_thread_id: 42 });
      await triggerTextMessage(ctx2);
      expect(opts.onMessage).not.toHaveBeenCalled();

      // Non-bot /commands should flow through
      const ctx3 = createTextCtx({
        text: '/remote-control',
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx3);
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '/remote-control' }),
      );
    });

    it('extracts sender name from first_name', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', firstName: 'Bob' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'Bob' }),
      );
    });

    it('falls back to username when first_name missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi' });
      ctx.from.first_name = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: 'alice_user' }),
      );
    });

    it('falls back to user ID when name and username missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Hi', fromId: 42 });
      ctx.from.first_name = undefined as any;
      ctx.from.username = undefined as any;
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ sender_name: '42' }),
      );
    });

    it('uses sender name as chat name for private chats', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'tg:100200300': {
            name: 'Private',
            folder: 'private',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'private',
        firstName: 'Alice',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Alice', // Private chats use sender name
        'telegram',
        false,
      );
    });

    it('uses chat title as name for group chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Hello',
        chatType: 'supergroup',
        chatTitle: 'Project Team',
      });
      await triggerTextMessage(ctx);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:100200300',
        expect.any(String),
        'Project Team',
        'telegram',
        true,
      );
    });

    it('converts message.date to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const unixTime = 1704067200; // 2024-01-01T00:00:00.000Z
      const ctx = createTextCtx({ text: 'Hello', date: unixTime });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot_username mention to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@andy_ai_bot what time is it?',
        entities: [{ type: 'mention', offset: 0, length: 12 }],
        message_thread_id: 42,
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@Andy @andy_ai_bot hello',
        entities: [{ type: 'mention', offset: 6, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Should NOT double-prepend — already starts with @Andy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy @andy_ai_bot hello',
        }),
      );
    });

    it('does not translate mentions of other bots', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: '@some_other_bot hi',
        entities: [{ type: 'mention', offset: 0, length: 15 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@some_other_bot hi', // No translation
        }),
      );
    });

    it('handles mention in middle of message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'hey @andy_ai_bot check this',
        entities: [{ type: 'mention', offset: 4, length: 12 }],
      });
      await triggerTextMessage(ctx);

      // Bot is mentioned, message doesn't match trigger → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '@Andy hey @andy_ai_bot check this',
        }),
      );
    });

    it('handles message with no entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'plain message' });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });

    it('ignores non-mention entities', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'check https://example.com',
        entities: [{ type: 'url', offset: 6, length: 19 }],
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'check https://example.com',
        }),
      );
    });

    it('exposes Telegram bot username as an assistant alias', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      expect(channel.getAssistantAliases?.('tg:100200300')).toEqual([
        '@andy_ai_bot',
      ]);
    });
  });

  // --- Reply context ---

  describe('reply context', () => {
    it('extracts reply_to fields when replying to a text message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Yes, on my way!',
        reply_to_message: {
          message_id: 42,
          text: 'Are you coming tonight?',
          from: { id: 12345, first_name: 'Andy', username: 'andy_ai_bot' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: 'Yes, on my way!',
          reply_to_message_id: '42',
          reply_to_message_content: 'Are you coming tonight?',
          reply_to_sender_name: 'Andy',
          reply_to_is_bot: true,
        }),
      );
    });

    it('uses caption when reply has no text (media reply)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Nice photo!',
        reply_to_message: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_content: 'Check this out',
        }),
      );
    });

    it('falls back to Unknown when reply sender has no from', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({
        text: 'Interesting',
        reply_to_message: {
          message_id: 60,
          text: 'Channel post',
        },
      });
      await triggerTextMessage(ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '60',
          reply_to_sender_name: 'Unknown',
        }),
      );
    });

    it('does not set reply fields when no reply_to_message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createTextCtx({ text: 'Just a normal message' });
      await triggerTextMessage(ctx);

      const delivered = vi.mocked(opts.onMessage).mock.calls[0]?.[1];
      expect(delivered).not.toHaveProperty('reply_to_message_id');
      expect(delivered).not.toHaveProperty('reply_to_message_content');
      expect(delivered).not.toHaveProperty('reply_to_sender_name');
      expect(delivered).not.toHaveProperty('reply_to_is_bot');
    });
  });

  // --- Non-text messages ---

  describe('non-text messages', () => {
    it('delivers media messages in regular group reply threads', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ message_thread_id: 42 });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: '[Location]',
        }),
      );
    });

    it('preserves reply_to_bot metadata for media replies', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        message_thread_id: 42,
        reply_to_message: {
          message_id: 77,
          text: 'Bot answer',
          from: { id: 12345, first_name: 'Andy' },
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '77',
          reply_to_message_content: 'Bot answer',
          reply_to_sender_name: 'Andy',
          reply_to_is_bot: true,
        }),
      );
    });

    it('preserves reply_to_human metadata for media replies without addressing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        message_thread_id: 42,
        reply_to_message: {
          message_id: 78,
          caption: 'Human photo',
          from: { id: 777, first_name: 'Bob' },
        },
      });
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '78',
          reply_to_message_content: 'Human photo',
          reply_to_sender_name: 'Bob',
          reply_to_is_bot: false,
        }),
      );
    });

    it('does not mark quoted forum service messages as reply_to_bot for media', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        message_thread_id: 42,
        reply_to_message: {
          message_id: 79,
          from: { id: 12345, first_name: 'Andy' },
          forum_topic_created: {},
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '79',
          reply_to_sender_name: 'Andy',
          reply_to_is_bot: false,
        }),
      );
    });

    it('preserves media reply metadata when bot id is unavailable', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        message_thread_id: 42,
        me: { username: 'andy_ai_bot' },
        reply_to_message: {
          message_id: 80,
          text: 'Maybe bot',
          from: { id: 12345, first_name: 'Andy' },
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          reply_to_message_id: '80',
          reply_to_message_content: 'Maybe bot',
          reply_to_is_bot: false,
        }),
      );
    });

    it('does not deliver media forum topic messages in Phase 1', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        chatType: 'supergroup',
        isForum: true,
        message_thread_id: 42,
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_topic_unsupported',
          threadId: 42,
        }),
        expect.any(String),
      );
    });

    it('ignores inbound media forum service updates without getChat or delivery', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
        extra: { forum_topic_created: {} },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(currentBot().api.getChat).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatJid: 'tg:100200300',
          messageId: '1',
          threadId: 42,
          reason: 'forum_service_message',
        }),
        'Telegram service message ignored',
      );
    });

    it('does not deliver media forum General topic messages in Phase 1', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        chatType: 'supergroup',
        isForum: true,
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_topic_unsupported',
          chatJid: 'tg:100200300',
        }),
        'Telegram forum media ignored',
      );
    });

    it('uses getChat to reject missing-status media messages without thread id when they are forum General topic traffic', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({ is_forum: true });
      const ctx = createMediaCtx({
        chatType: 'supergroup',
      });
      await triggerMediaMessage('message:location', ctx);

      expect(currentBot().api.getChat).toHaveBeenCalledWith(100200300);
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_topic_unsupported',
          threadId: undefined,
          chatJid: 'tg:100200300',
        }),
        'Telegram forum media ignored',
      );
    });

    it('delivers media when missing-status supergroup getChat omits optional is_forum', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockResolvedValueOnce({
        id: 100200300,
        type: 'supergroup',
        title: '루나방',
      });
      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
        reply_to_message: {
          message_id: 77,
          text: 'Bot answer',
          from: { id: 12345, first_name: 'Andy' },
        },
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: '[Location]',
          reply_to_message_id: '77',
          reply_to_is_bot: true,
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_missing_treated_as_non_forum',
          deliverable: true,
          threadId: 42,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('delivers media after missing-status thread lookup fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockRejectedValueOnce(new Error('network down'));
      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
        caption: 'Do not log caption',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('photo_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content:
            '[Photo] (/workspace/group/attachments/photo_1.jpg) Do not log caption',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_failed_treated_as_non_forum',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
      for (const [logData] of vi.mocked(logger.debug).mock.calls) {
        const serialized = JSON.stringify(logData);
        expect(serialized).not.toContain('Do not log caption');
        expect(serialized).not.toContain('caption');
        expect(serialized).not.toContain('photo_id');
        expect(serialized).not.toContain('reply_to_message_content');
      }
    });

    it('delivers media after missing-status thread lookup is rate limited', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockRejectedValueOnce({ error_code: 429 });
      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('photo_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_rate_limited_treated_as_non_forum',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('delivers media after missing-status thread lookup is unavailable', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      (currentBot().api as { getChat?: unknown }).getChat = undefined;
      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
      });
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: '[Location]',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_unavailable_treated_as_non_forum',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('delivers media after missing-status thread lookup times out', async () => {
      vi.useFakeTimers();
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getChat.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const ctx = createMediaCtx({
        chatType: 'supergroup',
        message_thread_id: 42,
      });
      const pending = triggerMediaMessage('message:location', ctx);

      await vi.advanceTimersByTimeAsync(1501);
      await pending;

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          chat_jid: 'tg:100200300',
          content: '[Location]',
        }),
      );
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'forum_status_lookup_timeout_treated_as_non_forum',
          threadId: 42,
          deliverable: true,
        }),
        'Telegram forum status lookup treated as non-forum',
      );
    });

    it('falls back to a media placeholder when Telegram getFile hangs', async () => {
      vi.useFakeTimers();
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockImplementationOnce(
        () => new Promise(() => {}),
      );
      const ctx = createMediaCtx({
        extra: {
          photo: [{ file_id: 'photo_id', width: 800 }],
        },
      });
      const pending = triggerMediaMessage('message:photo', ctx);

      await vi.advanceTimersByTimeAsync(30_001);
      await pending;

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo]',
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'photo_id' }),
        'Telegram getFile timed out',
      );
    });

    it('falls back to a media placeholder when Telegram file body hangs', async () => {
      vi.useFakeTimers();
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      undiciFetchRef.current.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: vi.fn(() => new Promise(() => {})),
      });
      const ctx = createMediaCtx({
        extra: {
          photo: [{ file_id: 'photo_id', width: 800 }],
        },
      });
      const pending = triggerMediaMessage('message:photo', ctx);

      await vi.advanceTimersByTimeAsync(30_001);
      await pending;

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo]',
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ fileId: 'photo_id' }),
        'Telegram file body download timed out',
      );
    });

    it('downloads photo and includes path in content', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: {
          photo: [
            { file_id: 'small_id', width: 90 },
            { file_id: 'large_id', width: 800 },
          ],
        },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('large_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Photo] (/workspace/group/attachments/photo_1.jpg)',
        }),
      );
    });

    it('downloads photo with caption', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        caption: 'Look at this',
        extra: { photo: [{ file_id: 'photo_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Photo] (/workspace/group/attachments/photo_1.jpg) Look at this',
        }),
      );
    });

    it('falls back to placeholder when download fails', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      // Make getFile reject
      currentBot().api.getFile.mockRejectedValueOnce(new Error('API error'));

      const ctx = createMediaCtx({
        caption: 'Check this',
        extra: { photo: [{ file_id: 'bad_id', width: 800 }] },
      });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Photo] Check this' }),
      );
    });

    it('downloads document and includes filename and path', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.pdf',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_name: 'report.pdf', file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('doc_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content:
            '[Document: report.pdf] (/workspace/group/attachments/report.pdf)',
        }),
      );
    });

    it('downloads video', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'videos/file_0.mp4',
      });

      const ctx = createMediaCtx({
        extra: { video: { file_id: 'vid_id' } },
      });
      await triggerMediaMessage('message:video', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('vid_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Video] (/workspace/group/attachments/video_1.mp4)',
        }),
      );
    });

    it('downloads voice message', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'voice/file_0.oga',
      });

      const ctx = createMediaCtx({
        extra: { voice: { file_id: 'voice_id' } },
      });
      await triggerMediaMessage('message:voice', ctx);
      await flushPromises();

      expect(currentBot().api.getFile).toHaveBeenCalledWith('voice_id');
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Voice message] (/workspace/group/attachments/voice_1.oga)',
        }),
      );
    });

    it('downloads audio with original filename', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'audio/file_0.mp3',
      });

      const ctx = createMediaCtx({
        extra: { audio: { file_id: 'audio_id', file_name: 'song.mp3' } },
      });
      await triggerMediaMessage('message:audio', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Audio] (/workspace/group/attachments/song.mp3)',
        }),
      );
    });

    it('stores sticker with emoji (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({
        extra: { sticker: { emoji: '😂' } },
      });
      await triggerMediaMessage('message:sticker', ctx);

      expect(currentBot().api.getFile).not.toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Sticker 😂]' }),
      );
    });

    it('stores location with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:location', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Location]' }),
      );
    });

    it('stores contact with placeholder (no download)', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({});
      await triggerMediaMessage('message:contact', ctx);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({ content: '[Contact]' }),
      );
    });

    it('ignores non-text messages from unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const ctx = createMediaCtx({ chatId: 999999 });
      await triggerMediaMessage('message:photo', ctx);
      await flushPromises();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'tg:999999',
        expect.any(String),
        undefined,
        'telegram',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('stores document with fallback name when filename missing', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.getFile.mockResolvedValueOnce({
        file_path: 'documents/file_0.bin',
      });

      const ctx = createMediaCtx({
        extra: { document: { file_id: 'doc_id' } },
      });
      await triggerMediaMessage('message:document', ctx);
      await flushPromises();

      expect(opts.onMessage).toHaveBeenCalledWith(
        'tg:100200300',
        expect.objectContaining({
          content: '[Document: file] (/workspace/group/attachments/file.bin)',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    function expectNoTelegramScopeParams(callIndex: number) {
      const options = currentBot().api.sendMessage.mock.calls[callIndex]?.[2];
      expect(options).not.toHaveProperty('reply_to_message_id');
      expect(options).not.toHaveProperty('message_thread_id');
      expect(options).not.toHaveProperty('allow_sending_without_reply');
    }

    it('sends message via bot API', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:100200300', 'Hello');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        expect.not.objectContaining({
          reply_to_message_id: expect.anything(),
          message_thread_id: expect.anything(),
          allow_sending_without_reply: expect.anything(),
        }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '100200300',
        'Hello',
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
      expectNoTelegramScopeParams(0);
    });

    it('strips tg: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.sendMessage('tg:-1001234567890', 'Group message');

      expect(currentBot().api.sendMessage).toHaveBeenCalledWith(
        '-1001234567890',
        'Group message',
        { parse_mode: 'Markdown' },
      );
    });

    it('splits messages exceeding 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('tg:100200300', longText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(2);
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        1,
        '100200300',
        'x'.repeat(4096),
        expect.not.objectContaining({
          reply_to_message_id: expect.anything(),
          message_thread_id: expect.anything(),
          allow_sending_without_reply: expect.anything(),
        }),
      );
      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'x'.repeat(904),
        expect.not.objectContaining({
          reply_to_message_id: expect.anything(),
          message_thread_id: expect.anything(),
          allow_sending_without_reply: expect.anything(),
        }),
      );
      expectNoTelegramScopeParams(0);
      expectNoTelegramScopeParams(1);
    });

    it('does not add reply or thread params to Markdown fallback sends', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot()
        .api.sendMessage.mockRejectedValueOnce(
          new Error('Markdown parse failed'),
        )
        .mockResolvedValueOnce(undefined);

      await channel.sendMessage('tg:100200300', 'Fallback');

      expect(currentBot().api.sendMessage).toHaveBeenNthCalledWith(
        2,
        '100200300',
        'Fallback',
        expect.not.objectContaining({
          reply_to_message_id: expect.anything(),
          message_thread_id: expect.anything(),
          allow_sending_without_reply: expect.anything(),
        }),
      );
      expectNoTelegramScopeParams(0);
      expectNoTelegramScopeParams(1);
    });

    it('sends exactly one message at 4096 characters', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const exactText = 'y'.repeat(4096);
      await channel.sendMessage('tg:100200300', exactText);

      expect(currentBot().api.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendMessage.mockRejectedValueOnce(
        new Error('Network error'),
      );

      // Should not throw
      await expect(
        channel.sendMessage('tg:100200300', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect — bot is null
      await channel.sendMessage('tg:100200300', 'No bot');

      // No error, no API call
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns tg: JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(true);
    });

    it('owns tg: JIDs with negative IDs (groups)', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('tg:-1001234567890')).toBe(true);
    });

    it('does not own WhatsApp group JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own WhatsApp DM JIDs', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing action when isTyping is true', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', true);

      expect(currentBot().api.sendChatAction).toHaveBeenCalledWith(
        '100200300',
        'typing',
      );
    });

    it('does nothing when isTyping is false', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      await channel.setTyping('tg:100200300', false);

      expect(currentBot().api.sendChatAction).not.toHaveBeenCalled();
    });

    it('does nothing when bot is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);

      // Don't connect
      await channel.setTyping('tg:100200300', true);

      // No error, no API call
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      currentBot().api.sendChatAction.mockRejectedValueOnce(
        new Error('Rate limited'),
      );

      await expect(
        channel.setTyping('tg:100200300', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- Bot commands ---

  describe('bot commands', () => {
    it('/chatid replies with chat ID and metadata', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 100200300, type: 'group' as const },
        from: { first_name: 'Alice' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('tg:100200300'),
        expect.objectContaining({ parse_mode: 'Markdown' }),
      );
    });

    it('/chatid shows chat type', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('chatid')!;
      const ctx = {
        chat: { id: 555, type: 'private' as const },
        from: { first_name: 'Bob' },
        reply: vi.fn(),
      };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('private'),
        expect.any(Object),
      );
    });

    it('/ping replies with bot status', async () => {
      const opts = createTestOpts();
      const channel = new TelegramChannel('test-token', opts);
      await channel.connect();

      const handler = currentBot().commandHandlers.get('ping')!;
      const ctx = { reply: vi.fn() };

      await handler(ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Andy is online.');
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "telegram"', () => {
      const channel = new TelegramChannel('test-token', createTestOpts());
      expect(channel.name).toBe('telegram');
    });
  });
});
