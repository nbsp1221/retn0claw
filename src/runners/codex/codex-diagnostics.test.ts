import { describe, expect, it } from 'vitest';

import {
  createCodexDiagnostics,
  type CodexCorrelationContext,
} from './codex-diagnostics.js';

const context: CodexCorrelationContext = {
  groupFolder: 'telegram_retn0_dm',
  chatJid: 'tg:436146054',
  runnerKind: 'codex',
  runId: 'run-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
};

describe('codex diagnostics', () => {
  it('emits stable correlated lifecycle events', () => {
    const diagnostics = createCodexDiagnostics(context);

    expect(diagnostics.runStarted()).toMatchObject({
      name: 'codex.run.started',
      groupFolder: 'telegram_retn0_dm',
      chatJid: 'tg:436146054',
      runnerKind: 'codex',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(
      diagnostics.runCompleted({ terminalReason: 'completed' }).details,
    ).toEqual({
      terminalReason: 'completed',
    });
  });

  it('includes elapsed age in stuck diagnostics', () => {
    const diagnostics = createCodexDiagnostics(context);

    expect(
      diagnostics.sessionStuck({
        observedAt: '2026-04-23T08:00:00.000Z',
        startedAt: '2026-04-23T07:55:00.000Z',
        reason: 'no_terminal_event',
      }),
    ).toMatchObject({
      name: 'codex.session.stuck',
      details: {
        observedAt: '2026-04-23T08:00:00.000Z',
        startedAt: '2026-04-23T07:55:00.000Z',
        elapsedMs: 300000,
        reason: 'no_terminal_event',
      },
    });
  });

  it('keeps parse-failure separate from semantic run failure', () => {
    const diagnostics = createCodexDiagnostics(context);

    expect(diagnostics.runParseFailure('bad json')).toMatchObject({
      name: 'codex.run.parse_failure',
      details: { error: 'bad json' },
    });
  });
});
