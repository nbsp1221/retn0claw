import { describe, expect, it, vi } from 'vitest';

import { connectInstalledChannels } from './connect.js';
import type { Channel } from '../types.js';
import type { ChannelFactory, ChannelOpts } from './registry.js';

function makeChannel(name: string, onConnect?: () => Promise<void>): Channel {
  return {
    name,
    connect: onConnect || vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ownsJid: () => false,
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOpts(): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({}),
  };
}

describe('connectInstalledChannels', () => {
  it('skips factories that return null', async () => {
    const factories = new Map<string, ChannelFactory>([
      ['telegram', () => null],
      ['discord', () => makeChannel('discord')],
    ]);

    const warn = vi.fn();
    const channels = await connectInstalledChannels({
      channelNames: ['telegram', 'discord'],
      getChannelFactory: (name) => factories.get(name),
      channelOpts: makeOpts(),
      warn,
    });

    expect(channels.map((channel) => channel.name)).toEqual(['discord']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('continues connecting later channels when one connect call fails', async () => {
    const failingChannel = makeChannel(
      'telegram',
      vi.fn().mockRejectedValue(new Error('bad token')),
    );
    const healthyChannel = makeChannel('discord');
    const factories = new Map<string, ChannelFactory>([
      ['telegram', () => failingChannel],
      ['discord', () => healthyChannel],
    ]);

    const warn = vi.fn();
    const channels = await connectInstalledChannels({
      channelNames: ['telegram', 'discord'],
      getChannelFactory: (name) => factories.get(name),
      channelOpts: makeOpts(),
      warn,
    });

    expect(channels.map((channel) => channel.name)).toEqual(['discord']);
    expect(warn).toHaveBeenCalledWith(
      { channel: 'telegram', err: expect.any(Error) },
      'Channel failed to connect — skipping integration',
    );
    expect(healthyChannel.connect).toHaveBeenCalledOnce();
  });
});
