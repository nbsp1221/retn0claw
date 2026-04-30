import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  extractTelegramReplyMetadata,
  isTelegramForumServiceMessage,
  resolveTelegramThreadDecision,
} from './telegram-threading.js';

const chat = (
  overrides: Partial<{
    id: number;
    type: string;
    is_forum: boolean;
  }> = {},
) => ({
  id: overrides.id ?? -100123,
  type: overrides.type ?? 'supergroup',
  ...(overrides.is_forum === undefined ? {} : { is_forum: overrides.is_forum }),
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveTelegramThreadDecision', () => {
  it('delivers regular group thread messages to the parent group identity', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat({ id: -123, type: 'group' }),
        messageThreadId: 42,
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-123',
      scope: 'none',
    });
  });

  it('delivers confirmed non-forum supergroup thread messages to the parent group identity', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat({ is_forum: false }),
        messageThreadId: 42,
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
    });
  });

  it('rejects confirmed forum supergroup thread messages in Phase 1', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat({ is_forum: true }),
        messageThreadId: 42,
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: false,
      chatJid: 'tg:-100123',
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    });
  });

  it('rejects confirmed forum supergroups without a thread id as General topic traffic', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat({ is_forum: true }),
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: false,
      chatJid: 'tg:-100123',
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    });
  });

  it('uses getChat to reject missing-status supergroups without a thread id when they are forum General topic traffic', async () => {
    const getChat = vi.fn().mockResolvedValue({ is_forum: true });

    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        isRegistered: true,
        getChat,
      }),
    ).resolves.toMatchObject({
      deliverable: false,
      chatJid: 'tg:-100123',
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    });
    expect(getChat).toHaveBeenCalledWith(-100123);
  });

  it('delivers missing-status supergroups without a thread id when getChat omits is_forum', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        isRegistered: true,
        getChat: vi.fn().mockResolvedValue({ type: 'supergroup' }),
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_missing_treated_as_non_forum',
    });
  });

  it('delivers private chat thread ids through the legacy DM identity', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat({ id: 12345, type: 'private' }),
        messageThreadId: 42,
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:12345',
      scope: 'dm',
    });
  });

  it('confirms missing-status registered supergroup threads with getChat before delivering', async () => {
    const getChat = vi.fn().mockResolvedValue({ is_forum: false });

    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat,
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
    });
    expect(getChat).toHaveBeenCalledWith(-100123);
  });

  it('delivers missing-status supergroup threads when getChat omits optional is_forum', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat: vi.fn().mockResolvedValue({
          id: -100123,
          type: 'supergroup',
          title: '루나방',
        }),
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_missing_treated_as_non_forum',
    });
  });

  it('treats missing-status supergroup threads as forum topics when getChat confirms forum', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat: vi.fn().mockResolvedValue({ is_forum: true }),
      }),
    ).resolves.toMatchObject({
      deliverable: false,
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    });
  });

  it('delivers missing-status supergroup threads when getChat is unavailable', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_unavailable_treated_as_non_forum',
    });
  });

  it('delivers missing-status supergroup threads when getChat rejects', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat: vi.fn().mockRejectedValue(new Error('network failed')),
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_failed_treated_as_non_forum',
    });
  });

  it('delivers missing-status supergroup threads when getChat throws synchronously', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat: vi.fn(() => {
          throw new Error('sync lookup failure');
        }),
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_failed_treated_as_non_forum',
    });
  });

  it('delivers missing-status supergroup threads when getChat times out', async () => {
    vi.useFakeTimers();
    const pending = resolveTelegramThreadDecision({
      chat: chat(),
      messageThreadId: 42,
      isRegistered: true,
      getChat: vi.fn(() => new Promise<{ is_forum?: boolean }>(() => {})),
      timeoutMs: 5,
    });

    await vi.advanceTimersByTimeAsync(6);

    await expect(pending).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_timeout_treated_as_non_forum',
    });
  });

  it('delivers missing-status supergroup threads when getChat is rate limited', async () => {
    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: true,
        getChat: vi.fn().mockRejectedValue({ error_code: 429 }),
      }),
    ).resolves.toMatchObject({
      deliverable: true,
      chatJid: 'tg:-100123',
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_rate_limited_treated_as_non_forum',
    });
  });

  it('does not call getChat for unregistered missing-status supergroup thread messages', async () => {
    const getChat = vi.fn().mockResolvedValue({ is_forum: false });

    await expect(
      resolveTelegramThreadDecision({
        chat: chat(),
        messageThreadId: 42,
        isRegistered: false,
        getChat,
      }),
    ).resolves.toMatchObject({
      deliverable: false,
      scope: 'none',
      reason: 'unregistered_chat',
    });
    expect(getChat).not.toHaveBeenCalled();
  });
});

describe('isTelegramForumServiceMessage', () => {
  it.each([
    'forum_topic_created',
    'forum_topic_edited',
    'forum_topic_closed',
    'forum_topic_reopened',
    'general_forum_topic_hidden',
    'general_forum_topic_unhidden',
  ])('detects %s by service field', (field) => {
    expect(
      isTelegramForumServiceMessage({
        message_id: 1,
        from: { id: 12345 },
        [field]: {},
      }),
    ).toBe(true);
  });

  it('does not treat ordinary text or captions as forum service messages', () => {
    expect(
      isTelegramForumServiceMessage({
        message_id: 1,
        text: 'forum_topic_created',
        caption: 'general_forum_topic_hidden',
      }),
    ).toBe(false);
  });
});

describe('extractTelegramReplyMetadata', () => {
  it('extracts reply metadata from a quoted text message', () => {
    expect(
      extractTelegramReplyMetadata({
        botId: 12345,
        replyTo: {
          message_id: 42,
          text: 'Are you coming?',
          from: { id: 12345, first_name: 'Andy', username: 'andy_ai_bot' },
        },
      }),
    ).toEqual({
      reply_to_message_id: '42',
      reply_to_message_content: 'Are you coming?',
      reply_to_sender_name: 'Andy',
      reply_to_is_bot: true,
    });
  });

  it('uses caption when quoted message has no text', () => {
    expect(
      extractTelegramReplyMetadata({
        botId: 12345,
        replyTo: {
          message_id: 50,
          caption: 'Check this out',
          from: { id: 888, first_name: 'Carol' },
        },
      }),
    ).toMatchObject({
      reply_to_message_content: 'Check this out',
      reply_to_sender_name: 'Carol',
      reply_to_is_bot: false,
    });
  });

  it('falls back to Unknown when quoted sender is missing', () => {
    expect(
      extractTelegramReplyMetadata({
        botId: 12345,
        replyTo: {
          message_id: 60,
          text: 'Channel post',
        },
      }),
    ).toMatchObject({
      reply_to_message_id: '60',
      reply_to_sender_name: 'Unknown',
      reply_to_is_bot: false,
    });
  });

  it('preserves reply metadata without implicit addressing when bot id is unavailable', () => {
    expect(
      extractTelegramReplyMetadata({
        replyTo: {
          message_id: 70,
          text: 'Prior bot text',
          from: { id: 12345, first_name: 'Andy' },
        },
      }),
    ).toMatchObject({
      reply_to_message_id: '70',
      reply_to_message_content: 'Prior bot text',
      reply_to_sender_name: 'Andy',
      reply_to_is_bot: false,
    });
  });

  it('does not mark forum service messages as reply_to_bot', () => {
    expect(
      extractTelegramReplyMetadata({
        botId: 12345,
        replyTo: {
          message_id: 80,
          from: { id: 12345, first_name: 'Andy' },
          forum_topic_created: {},
        },
      }),
    ).toMatchObject({
      reply_to_message_id: '80',
      reply_to_sender_name: 'Andy',
      reply_to_is_bot: false,
    });
  });

  it('returns no fields when there is no quoted message', () => {
    expect(
      extractTelegramReplyMetadata({
        botId: 12345,
        replyTo: undefined,
      }),
    ).toEqual({});
  });
});
