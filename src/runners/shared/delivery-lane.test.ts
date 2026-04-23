import { describe, expect, it } from 'vitest';

import { createDeliveryLane } from './delivery-lane.js';
import type { RunnerOutput } from './runner.js';

function output(overrides: Partial<RunnerOutput>): RunnerOutput {
  return {
    status: 'success',
    eventKind: 'final',
    phase: 'final',
    threadId: 'thread-1',
    turnId: 'turn-1',
    result: 'done',
    ...overrides,
  };
}

describe('delivery lane', () => {
  it('suppresses duplicate terminal outputs after the first final', () => {
    const lane = createDeliveryLane();

    expect(
      lane.consume(
        output({
          eventKind: 'meta',
          phase: 'meta',
          result: null,
          turnId: null,
        }),
      ),
    ).toEqual({
      sendText: null,
      notifyIdle: false,
    });

    expect(
      lane.consume(
        output({ eventKind: 'progress', phase: 'progress', result: 'draft' }),
      ),
    ).toEqual({
      sendText: null,
      notifyIdle: false,
    });

    expect(lane.consume(output({ result: 'done' }))).toEqual({
      sendText: 'done',
      notifyIdle: true,
    });

    expect(lane.consume(output({ result: 'done again' }))).toEqual({
      sendText: null,
      notifyIdle: false,
    });
  });

  it('closes the lane on terminal errors without notifying idle', () => {
    const lane = createDeliveryLane();

    expect(
      lane.consume(
        output({
          status: 'error',
          eventKind: 'turn_failed',
          phase: 'final',
          result: null,
          error: 'boom',
        }),
      ),
    ).toEqual({ sendText: null, notifyIdle: false });

    expect(lane.consume(output({ result: 'too late' }))).toEqual({
      sendText: null,
      notifyIdle: false,
    });
  });
});
