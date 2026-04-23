import { describe, expect, it, vi } from 'vitest';

import { DiscordChannel } from '../../../src/channels/discord.js';
import { semanticFinalCount } from '../../support/assertions.js';
import type { VisibleAction } from '../../support/visible-actions.js';

function createChannel(send: ReturnType<typeof vi.fn>) {
  const channel = new DiscordChannel('token', {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
  });
  (channel as any).client = {
    channels: {
      fetch: vi.fn().mockResolvedValue({
        send,
      }),
    },
  };
  return channel;
}

async function deliverSemanticFinals(
  channel: DiscordChannel,
  jid: string,
  actions: readonly VisibleAction[],
): Promise<void> {
  for (const action of actions) {
    if (action.type === 'final_send') {
      await channel.sendMessage(jid, action.text);
    }
  }
}

describe('transport integration: discord delivery', () => {
  it('splits long outbound payloads while preserving one semantic final', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const channel = createChannel(send);
    const actions: VisibleAction[] = [
      { type: 'final_send', text: 'y'.repeat(2500) },
    ];

    await deliverSemanticFinals(channel, 'dc:1234567890', actions);

    expect(semanticFinalCount(actions)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenNthCalledWith(1, 'y'.repeat(2000));
    expect(send).toHaveBeenNthCalledWith(2, 'y'.repeat(500));
  });
});
