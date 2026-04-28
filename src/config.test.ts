import { describe, expect, it } from 'vitest';

import {
  parseChatContextPolicyConfig,
  resolveChatContextPolicy,
} from './config.js';

describe('chat context policy config', () => {
  it('falls back to built-in defaults when config JSON is invalid', () => {
    const config = parseChatContextPolicyConfig('{not json');

    expect(
      resolveChatContextPolicy({
        chatType: 'group',
        platform: 'telegram',
        config,
      }),
    ).toBe('addressed_only');
    expect(
      resolveChatContextPolicy({
        chatType: 'dm',
        platform: 'telegram',
        config,
      }),
    ).toBe('current');
  });

  it('ignores unknown policy values', () => {
    const config = parseChatContextPolicyConfig(
      JSON.stringify({
        defaults: { group: 'recent_all', dm: 'everything' },
        channels: { telegram: { group: 'all_messages' } },
      }),
    );

    expect(
      resolveChatContextPolicy({
        chatType: 'group',
        platform: 'telegram',
        config,
      }),
    ).toBe('recent_all');
    expect(
      resolveChatContextPolicy({
        chatType: 'dm',
        platform: 'telegram',
        config,
      }),
    ).toBe('current');
  });

  it('resolves room override over channel override over global default', () => {
    const config = parseChatContextPolicyConfig(
      JSON.stringify({
        defaults: { group: 'addressed_only' },
        channels: { telegram: { group: 'recent_addressed' } },
      }),
    );

    expect(
      resolveChatContextPolicy({
        chatType: 'group',
        platform: 'telegram',
        config,
      }),
    ).toBe('recent_addressed');

    expect(
      resolveChatContextPolicy({
        chatType: 'group',
        platform: 'telegram',
        registeredGroup: { contextPolicy: 'recent_all' },
        config,
      }),
    ).toBe('recent_all');
  });
});
