import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  extractTelegramReplyMetadata,
  resolveTelegramThreadDecision,
} from '../../src/channels/telegram-threading.js';

const runs = { numRuns: Number(process.env.PROPERTY_RUNS || 50) };

describe('telegram thread scope properties', () => {
  it('never encodes Telegram message_thread_id into the parent chat jid', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 2_000_000_000 }),
        fc.constantFrom<'private' | 'group' | 'supergroup'>(
          'private',
          'group',
          'supergroup',
        ),
        async (chatId, threadId, chatType) => {
          const decision = await resolveTelegramThreadDecision({
            chat: { id: chatId, type: chatType, is_forum: false },
            messageThreadId: threadId,
            isRegistered: true,
            getChat: async () => ({ is_forum: false }),
          });

          expect(decision.chatJid).toBe(`tg:${chatId}`);
        },
      ),
      runs,
    );
  });

  it('rejects known forum topic messages regardless of chat id or thread id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 2_000_000_000 }),
        async (chatId, threadId) => {
          const decision = await resolveTelegramThreadDecision({
            chat: { id: chatId, type: 'supergroup', is_forum: true },
            messageThreadId: threadId,
            isRegistered: true,
          });

          expect(decision).toMatchObject({
            deliverable: false,
            chatJid: `tg:${chatId}`,
            scope: 'forum',
            reason: 'forum_topic_unsupported',
          });
        },
      ),
      runs,
    );
  });

  it('rejects known forum General topic messages even when Telegram omits thread id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        async (chatId) => {
          const decision = await resolveTelegramThreadDecision({
            chat: { id: chatId, type: 'supergroup', is_forum: true },
            isRegistered: true,
          });

          expect(decision).toMatchObject({
            deliverable: false,
            chatJid: `tg:${chatId}`,
            scope: 'forum',
            reason: 'forum_topic_unsupported',
          });
        },
      ),
      runs,
    );
  });

  it('only positive forum evidence blocks registered missing-status supergroups', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        fc.option(fc.integer({ min: 1, max: 2_000_000_000 }), {
          nil: undefined,
        }),
        fc.constantFrom(
          'forum',
          'non-forum',
          'missing',
          'unavailable',
          'failure',
          'rate-limit',
          'timeout',
        ),
        async (chatId, threadId, lookupMode) => {
          const getChat =
            lookupMode === 'unavailable'
              ? undefined
              : vi.fn(() => {
                  if (lookupMode === 'forum') {
                    return Promise.resolve({ is_forum: true });
                  }
                  if (lookupMode === 'non-forum') {
                    return Promise.resolve({ is_forum: false });
                  }
                  if (lookupMode === 'missing') {
                    return Promise.resolve({});
                  }
                  if (lookupMode === 'rate-limit') {
                    return Promise.reject({ error_code: 429 });
                  }
                  if (lookupMode === 'timeout') {
                    return new Promise<{ is_forum?: boolean }>(() => {});
                  }
                  return Promise.reject(new Error('lookup failed'));
                });

          const decision = await resolveTelegramThreadDecision({
            chat: { id: chatId, type: 'supergroup' },
            messageThreadId: threadId,
            isRegistered: true,
            getChat,
            timeoutMs: lookupMode === 'timeout' ? 1 : undefined,
          });

          if (lookupMode === 'forum') {
            expect(decision).toMatchObject({
              deliverable: false,
              chatJid: `tg:${chatId}`,
              scope: 'forum',
              reason: 'forum_topic_unsupported',
            });
            return;
          }

          expect(decision).toMatchObject({
            deliverable: true,
            chatJid: `tg:${chatId}`,
            scope: 'none',
          });
        },
      ),
      runs,
    );
  });

  it('does not probe unregistered missing-status supergroups', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 2_000_000_000 }),
        async (chatId, threadId) => {
          const getChat = vi.fn(async () => ({ is_forum: false }));

          const decision = await resolveTelegramThreadDecision({
            chat: { id: chatId, type: 'supergroup' },
            messageThreadId: threadId,
            isRegistered: false,
            getChat,
          });

          expect(getChat).not.toHaveBeenCalled();
          expect(decision).toMatchObject({
            deliverable: false,
            chatJid: `tg:${chatId}`,
            scope: 'none',
            reason: 'unregistered_chat',
          });
        },
      ),
      runs,
    );
  });

  it('marks reply metadata as bot-only when the quoted sender matches the known bot id and is not a service message', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2_000_000_000 }),
        fc.integer({ min: 1, max: 2_000_000_000 }),
        fc.boolean(),
        (botId, senderId, isServiceMessage) => {
          const replyTo = {
            message_id: 77,
            text: 'quoted answer',
            from: { id: senderId, first_name: 'Sender' },
            ...(isServiceMessage ? { forum_topic_created: {} } : {}),
          };

          const metadata = extractTelegramReplyMetadata({
            replyTo,
            botId,
          });

          expect(metadata.reply_to_is_bot).toBe(
            senderId === botId && !isServiceMessage,
          );
        },
      ),
      runs,
    );
  });

  it('does not mark reply metadata as bot-addressed when the bot id is unavailable', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2_000_000_000 }), (senderId) => {
        const metadata = extractTelegramReplyMetadata({
          replyTo: {
            message_id: 77,
            text: 'quoted answer',
            from: { id: senderId, first_name: 'Sender' },
          },
        });

        expect(metadata.reply_to_is_bot).toBe(false);
      }),
      runs,
    );
  });
});
