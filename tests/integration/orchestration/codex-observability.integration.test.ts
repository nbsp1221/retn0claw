import { describe, expect, it, vi } from 'vitest';

import { createDeliveryAuditLogger } from '../../../src/runners/shared/delivery-audit.js';
import { createDeliveryLane } from '../../../src/runners/shared/delivery-lane.js';
import type { RunnerOutput } from '../../../src/runners/shared/runner.js';

function output(overrides: Partial<RunnerOutput>): RunnerOutput {
  return {
    status: 'success',
    eventKind: 'final',
    phase: 'final',
    threadId: 'thread-1',
    turnId: 'turn-1',
    result: '최종 답변',
    ...overrides,
  };
}

describe('integration: codex observability correlation', () => {
  it('keeps one runId across delivery decisions and final-send audit', () => {
    const seen: unknown[] = [];
    const audit = createDeliveryAuditLogger(
      {
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      },
      (event) => seen.push(event),
    );

    const lane = createDeliveryLane({ audit });
    const sendMessage = vi.fn(async (_chatJid: string, text: string) => {
      audit.finalSent(text);
    });

    lane.consume(
      output({ eventKind: 'progress', phase: 'progress', result: '초안' }),
    );
    const delivery = lane.consume(output({ result: '최종 답변' }));
    if (delivery.sendText) {
      void sendMessage('tg:436146054', delivery.sendText);
    }

    expect(seen).toEqual([
      expect.objectContaining({
        name: 'delivery.final_sent',
        runId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
      }),
    ]);
  });
});
