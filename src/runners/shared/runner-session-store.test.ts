import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase, setSession } from '../../db.js';

describe('runner session store', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('stores sessions independently per runner kind', async () => {
    const mod = await import('./runner-session-store.js');

    mod.setRunnerSession('claude', 'group-a', 'claude-session');
    mod.setRunnerSession('codex', 'group-a', 'codex-session');

    expect(mod.getRunnerSession('claude', 'group-a')).toBe('claude-session');
    expect(mod.getRunnerSession('codex', 'group-a')).toBe('codex-session');
    expect(mod.getRunnerSessions('claude')).toEqual({
      'group-a': 'claude-session',
    });
    expect(mod.getRunnerSessions('codex')).toEqual({
      'group-a': 'codex-session',
    });
  });

  it('backfills legacy sessions into the claude runner namespace idempotently', async () => {
    const mod = await import('./runner-session-store.js');

    setSession('legacy-group', 'legacy-session');

    expect(mod.backfillLegacyClaudeSessions()).toBe(1);
    expect(mod.backfillLegacyClaudeSessions()).toBe(0);
    expect(mod.getRunnerSession('claude', 'legacy-group')).toBe(
      'legacy-session',
    );
  });
});
