import { describe, expect, it } from 'vitest';

import {
  createDeliveryAuditEvent,
  createDeliveryAuditLogger,
  createRunnerOutputAuditLoggerFactory,
  type DeliveryAuditContext,
} from './delivery-audit.js';

const context: DeliveryAuditContext = {
  groupFolder: 'telegram_retn0_dm',
  chatJid: 'tg:436146054',
  runnerKind: 'codex',
  runId: 'run-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
};

describe('delivery audit', () => {
  it('creates stable final-sent event shape', () => {
    expect(
      createDeliveryAuditEvent(context, 'delivery.final_sent', {
        textLength: 12,
      }),
    ).toEqual({
      name: 'delivery.final_sent',
      groupFolder: 'telegram_retn0_dm',
      chatJid: 'tg:436146054',
      runnerKind: 'codex',
      runId: 'run-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      details: {
        textLength: 12,
      },
    });
  });

  it('uses one shared logger shape for sent, suppressed, and failed finals', () => {
    const seen: unknown[] = [];
    const audit = createDeliveryAuditLogger(context, (event) => {
      seen.push(event);
    });

    audit.finalSent('done');
    audit.finalSuppressed('duplicate_terminal');
    audit.finalFailed('boom');

    expect(seen).toEqual([
      expect.objectContaining({ name: 'delivery.final_sent' }),
      expect.objectContaining({ name: 'delivery.final_suppressed' }),
      expect.objectContaining({ name: 'delivery.final_failed' }),
    ]);
  });

  it('creates output-aware audit loggers with fallback thread correlation', () => {
    const seen: unknown[] = [];
    const createAudit = createRunnerOutputAuditLoggerFactory(
      {
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-2',
      },
      () => 'session-thread',
      (event) => {
        seen.push(event);
      },
    );

    createAudit({
      status: 'success',
      eventKind: 'final',
      phase: 'final',
      threadId: null,
      turnId: 'turn-9',
      result: 'done',
      newSessionId: undefined,
    }).finalSent('done');

    expect(seen).toEqual([
      expect.objectContaining({
        name: 'delivery.final_sent',
        threadId: 'session-thread',
        turnId: 'turn-9',
      }),
    ]);
  });
});
