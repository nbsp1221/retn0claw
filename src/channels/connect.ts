import type { Channel } from '../types.js';
import type { ChannelFactory, ChannelOpts } from './registry.js';

export async function connectInstalledChannels(args: {
  channelNames: string[];
  getChannelFactory: (name: string) => ChannelFactory | undefined;
  channelOpts: ChannelOpts;
  warn: (data: Record<string, unknown>, msg: string) => void;
}): Promise<Channel[]> {
  const connectedChannels: Channel[] = [];

  for (const channelName of args.channelNames) {
    const factory = args.getChannelFactory(channelName);
    if (!factory) continue;

    const channel = factory(args.channelOpts);
    if (!channel) {
      args.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }

    try {
      await channel.connect();
      connectedChannels.push(channel);
    } catch (err) {
      args.warn(
        { channel: channelName, err },
        'Channel failed to connect — skipping integration',
      );
    }
  }

  return connectedChannels;
}
