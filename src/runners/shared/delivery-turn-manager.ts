import {
  createDeliveryLane,
  type DeliveryLaneDecision,
} from './delivery-lane.js';
import type { createDeliveryAuditLogger } from './delivery-audit.js';
import type { RunnerOutput } from './runner.js';

type DeliveryAuditLogger = ReturnType<typeof createDeliveryAuditLogger>;

export interface DeliveryTurnManagerState {
  activeTurnKey: string | null;
  knownTurnKeys: string[];
}

function toTurnKey(output: RunnerOutput): string {
  if (output.turnId) {
    return `turn:${output.turnId}`;
  }
  if (output.threadId) {
    return `implicit:${output.threadId}`;
  }
  return 'implicit:run';
}

function toLaneOutput(output: RunnerOutput): RunnerOutput {
  if (
    output.eventKind === 'turn_failed' ||
    output.eventKind === 'turn_interrupted'
  ) {
    return {
      ...output,
      status: 'error',
      phase: 'final',
    };
  }
  if (output.eventKind === 'turn_started') {
    return {
      ...output,
      phase: 'meta',
      result: null,
    };
  }
  return output;
}

export function createDeliveryTurnManager(options?: {
  createAuditLogger?: (output: RunnerOutput) => DeliveryAuditLogger;
}): {
  consume(output: RunnerOutput): DeliveryLaneDecision;
  getState(): DeliveryTurnManagerState;
} {
  const lanes = new Map<string, ReturnType<typeof createDeliveryLane>>();
  let activeTurnKey: string | null = null;

  function getOrCreateLane(output: RunnerOutput) {
    const turnKey = toTurnKey(output);
    let lane = lanes.get(turnKey);
    if (!lane) {
      lane = createDeliveryLane({
        audit: options?.createAuditLogger?.(output),
      });
      lanes.set(turnKey, lane);
    }
    return { turnKey, lane };
  }

  return {
    consume(output: RunnerOutput): DeliveryLaneDecision {
      if (output.eventKind === 'meta' && output.turnId === null) {
        return { sendText: null, notifyIdle: false };
      }

      const { turnKey, lane } = getOrCreateLane(output);

      if (output.eventKind === 'turn_started') {
        activeTurnKey = turnKey;
        return { sendText: null, notifyIdle: false };
      }

      if (activeTurnKey === null) {
        activeTurnKey = turnKey;
      } else if (turnKey !== activeTurnKey && output.turnId !== null) {
        if (
          output.eventKind === 'final' ||
          output.eventKind === 'turn_failed' ||
          output.eventKind === 'turn_interrupted'
        ) {
          options?.createAuditLogger?.(output).finalSuppressed('inactive_turn');
        }
        return { sendText: null, notifyIdle: false };
      }

      return lane.consume(toLaneOutput(output));
    },
    getState() {
      return {
        activeTurnKey,
        knownTurnKeys: [...lanes.keys()],
      };
    },
  };
}
