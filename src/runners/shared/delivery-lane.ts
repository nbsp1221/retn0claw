import type { RunnerOutput } from './runner.js';
import type { createDeliveryAuditLogger } from './delivery-audit.js';

export interface DeliveryLaneDecision {
  sendText: string | null;
  notifyIdle: boolean;
}

export interface DeliveryLaneState {
  terminal: boolean;
  previewText: string | null;
}

type DeliveryAuditLogger = ReturnType<typeof createDeliveryAuditLogger>;

export function createDeliveryLane(): {
  consume(output: RunnerOutput): DeliveryLaneDecision;
  getState(): DeliveryLaneState;
};
export function createDeliveryLane(options: { audit?: DeliveryAuditLogger }): {
  consume(output: RunnerOutput): DeliveryLaneDecision;
  getState(): DeliveryLaneState;
};
export function createDeliveryLane(options?: { audit?: DeliveryAuditLogger }): {
  consume(output: RunnerOutput): DeliveryLaneDecision;
  getState(): DeliveryLaneState;
} {
  let terminal = false;
  let previewText: string | null = null;
  const audit = options?.audit;

  return {
    consume(output: RunnerOutput): DeliveryLaneDecision {
      if (terminal) {
        if (output.phase === undefined || output.phase === 'final') {
          audit?.finalSuppressed('duplicate_terminal');
        }
        return { sendText: null, notifyIdle: false };
      }

      if (output.phase === 'meta') {
        return { sendText: null, notifyIdle: false };
      }

      if (output.phase === 'progress') {
        previewText =
          typeof output.result === 'string' && output.result.trim()
            ? output.result
            : previewText;
        return { sendText: null, notifyIdle: false };
      }

      terminal = true;
      previewText = null;

      return {
        sendText:
          typeof output.result === 'string' && output.result.length > 0
            ? output.result
            : null,
        notifyIdle: output.status === 'success',
      };
    },
    getState() {
      return { terminal, previewText };
    },
  };
}
