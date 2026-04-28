import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  sanitizeLeadingInvocation,
  selectChatSurfaceMessages,
} from '../../src/prompt/chat-surface.js';
import type { NewMessage } from '../../src/types.js';

function msg(id: string, content: string): NewMessage {
  return {
    id,
    chat_jid: 'tg:-100',
    sender: `sender-${id}`,
    sender_name: `Sender ${id}`,
    content,
    timestamp: `2026-04-24T00:00:${id.padStart(2, '0')}.000Z`,
  };
}

const unaddressedText = fc
  .string({ minLength: 1 })
  .filter((value) => !value.trimStart().startsWith('@Andy'));

describe('chat surface mention properties', () => {
  it('sanitization is idempotent', () => {
    fc.assert(
      fc.property(fc.string(), (body) => {
        const opts = {
          trigger: '@Andy',
          assistantAliases: ['@andy_ai_bot', '<@123>'],
        };
        const input = `@Andy @andy_ai_bot ${body}`;
        const once = sanitizeLeadingInvocation(input, opts);
        expect(sanitizeLeadingInvocation(once, opts)).toBe(once);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS || 50) },
    );
  });

  it('preserves non-leading trigger text', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (prefix) => {
        fc.pre(/\S/u.test(prefix));
        fc.pre(!prefix.trimStart().startsWith('@'));
        const input = `${prefix} @Andy hello`;
        expect(sanitizeLeadingInvocation(input, { trigger: '@Andy' })).toBe(
          input,
        );
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS || 50) },
    );
  });

  it('default group selection does not leak unaddressed neighbors', () => {
    fc.assert(
      fc.property(unaddressedText, unaddressedText, (before, after) => {
        const selected = selectChatSurfaceMessages({
          chatType: 'group',
          trigger: '@Andy',
          assistantAliases: [],
          contextPolicy: 'addressed_only',
          isGroupMessageAllowed: () => true,
          messages: [
            msg('1', before),
            msg('2', '@Andy answer this'),
            msg('3', after),
          ],
        });

        expect(selected.latestMessage?.id).toBe('2');
        expect(selected.recentMessages).toEqual([]);
      }),
      { numRuns: Number(process.env.PROPERTY_RUNS || 50) },
    );
  });
});
