import { describe, expect, it } from 'vitest';

import { sanitizeCodexTraceRecord } from '../../../src/runners/codex/codex-trace-sanitizer.js';

describe('contract: codex trace promotion', () => {
  it('preserves correlation fields while sanitizing secrets', () => {
    const record = sanitizeCodexTraceRecord({
      groupFolder: 'telegram_retn0_dm',
      chatJid: 'tg:436146054',
      runnerKind: 'codex',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      payload: {
        accessToken: 'sk-live-abcdef',
      },
    });

    expect(record).toEqual({
      groupFolder: 'telegram_retn0_dm',
      chatJid: 'tg:436146054',
      runnerKind: 'codex',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      payload: {
        accessToken: '[REDACTED_TOKEN]',
      },
    });
  });
});
