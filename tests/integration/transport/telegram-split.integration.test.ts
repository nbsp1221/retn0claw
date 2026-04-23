import { describe, expect, it, vi } from 'vitest';

import { TelegramChannel } from '../../../src/channels/telegram.js';
import { semanticFinalCount } from '../../support/assertions.js';
import type { VisibleAction } from '../../support/visible-actions.js';

function createChannel(sendMessage: ReturnType<typeof vi.fn>) {
  const channel = new TelegramChannel('token', {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  });
  (channel as any).bot = { api: { sendMessage } };
  return channel;
}

async function deliverSemanticFinals(
  channel: TelegramChannel,
  jid: string,
  actions: readonly VisibleAction[],
): Promise<void> {
  for (const action of actions) {
    if (action.type === 'final_send') {
      await channel.sendMessage(jid, action.text);
    }
  }
}

describe('transport integration: telegram split delivery', () => {
  it('splits long payloads at the transport layer while preserving one semantic final', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const channel = createChannel(sendMessage);
    const actions: VisibleAction[] = [
      { type: 'final_send', text: 'x'.repeat(5000) },
    ];

    await deliverSemanticFinals(channel, 'tg:100200300', actions);

    expect(semanticFinalCount(actions)).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      '100200300',
      'x'.repeat(4096),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      '100200300',
      'x'.repeat(904),
      expect.objectContaining({ parse_mode: 'Markdown' }),
    );
  });
});
