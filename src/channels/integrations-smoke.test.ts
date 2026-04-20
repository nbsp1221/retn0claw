import { describe, expect, it } from 'vitest';

import './index.js';
import { getRegisteredChannelNames } from './registry.js';

describe('official channel integrations', () => {
  it('self-registers telegram and discord channels from the barrel import', () => {
    const names = getRegisteredChannelNames();

    expect(names).toContain('telegram');
    expect(names).toContain('discord');
  });
});
