import { describe, expect, it, vi } from 'vitest';

import { createDeliveryTurnManager } from './delivery-turn-manager.js';

function output(overrides: Record<string, unknown>) {
  return {
    status: 'success',
    eventKind: 'final',
    phase: 'final',
    threadId: 'thread-1',
    turnId: 'turn-1',
    result: 'done',
    ...overrides,
  } as const;
}

describe('delivery turn manager', () => {
  it('allows one final per distinct turn on the same thread', () => {
    const manager = createDeliveryTurnManager();

    expect(
      manager.consume(
        output({
          eventKind: 'turn_started',
          phase: 'meta',
          result: null,
        }),
      ),
    ).toEqual({ sendText: null, notifyIdle: false });

    expect(manager.consume(output({ result: '첫 번째 답변' }))).toEqual({
      sendText: '첫 번째 답변',
      notifyIdle: true,
    });

    expect(
      manager.consume(
        output({
          eventKind: 'turn_started',
          phase: 'meta',
          turnId: 'turn-2',
          result: null,
        }),
      ),
    ).toEqual({ sendText: null, notifyIdle: false });

    expect(
      manager.consume(
        output({
          turnId: 'turn-2',
          result: '두 번째 답변',
        }),
      ),
    ).toEqual({ sendText: '두 번째 답변', notifyIdle: true });
  });

  it('still suppresses duplicate finals within the same turn', () => {
    const suppressed = vi.fn();
    const manager = createDeliveryTurnManager({
      createAuditLogger: () => ({
        finalSent: vi.fn(),
        finalReplaced: vi.fn(),
        finalSuppressed: suppressed,
        finalFailed: vi.fn(),
      }),
    });

    manager.consume(
      output({
        eventKind: 'turn_started',
        phase: 'meta',
        result: null,
      }),
    );

    expect(manager.consume(output({ result: '하나만' }))).toEqual({
      sendText: '하나만',
      notifyIdle: true,
    });
    expect(manager.consume(output({ result: '하나만' }))).toEqual({
      sendText: null,
      notifyIdle: false,
    });
    expect(suppressed).toHaveBeenCalledWith('duplicate_terminal');
  });

  it('suppresses late terminal output from an inactive turn after rollover', () => {
    const suppressed = vi.fn();
    const manager = createDeliveryTurnManager({
      createAuditLogger: () => ({
        finalSent: vi.fn(),
        finalReplaced: vi.fn(),
        finalSuppressed: suppressed,
        finalFailed: vi.fn(),
      }),
    });

    manager.consume(
      output({
        eventKind: 'turn_started',
        phase: 'meta',
        turnId: 'turn-1',
        result: null,
      }),
    );
    manager.consume(output({ turnId: 'turn-1', result: '첫 번째 답변' }));
    manager.consume(
      output({
        eventKind: 'turn_started',
        phase: 'meta',
        turnId: 'turn-2',
        result: null,
      }),
    );

    expect(
      manager.consume(
        output({ turnId: 'turn-1', result: '늦은 첫 번째 답변' }),
      ),
    ).toEqual({
      sendText: null,
      notifyIdle: false,
    });
    expect(suppressed).toHaveBeenCalledWith('inactive_turn');
  });
});
