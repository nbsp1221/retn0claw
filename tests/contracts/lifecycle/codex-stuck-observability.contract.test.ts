import { describe, expect, it } from 'vitest';

import { createCodexDiagnostics } from '../../../src/runners/codex/codex-diagnostics.js';

describe('contract: codex stuck observability', () => {
  it('emits reconstructable evidence when a turn has no terminal event within bound', () => {
    const diagnostics = createCodexDiagnostics({
      groupFolder: 'telegram_retn0_dm',
      chatJid: 'tg:436146054',
      runnerKind: 'codex',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });

    expect(
      diagnostics.sessionStuck({
        startedAt: '2026-04-23T08:00:00.000Z',
        observedAt: '2026-04-23T08:05:00.000Z',
        reason: 'no_terminal_event',
      }),
    ).toMatchObject({
      name: 'codex.session.stuck',
      groupFolder: 'telegram_retn0_dm',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      details: expect.objectContaining({
        elapsedMs: 300000,
        reason: 'no_terminal_event',
      }),
    });
  });
});
