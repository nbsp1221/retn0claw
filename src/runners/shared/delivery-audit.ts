import { logger } from '../../logger.js';
import type { RunnerKind, RunnerOutput } from './runner.js';

export interface DeliveryAuditContext {
  groupFolder: string | null;
  chatJid: string | null;
  runnerKind: RunnerKind | null;
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface DeliveryAuditEvent extends DeliveryAuditContext {
  name:
    | 'delivery.final_sent'
    | 'delivery.final_replaced'
    | 'delivery.final_suppressed'
    | 'delivery.final_failed';
  details?: Record<string, unknown>;
}

export interface DeliveryAuditRunContext {
  groupFolder: string;
  chatJid: string;
  runnerKind: RunnerKind;
  runId: string;
}

export function createDeliveryAuditEvent(
  context: DeliveryAuditContext,
  name: DeliveryAuditEvent['name'],
  details?: Record<string, unknown>,
): DeliveryAuditEvent {
  return {
    name,
    groupFolder: context.groupFolder,
    chatJid: context.chatJid,
    runnerKind: context.runnerKind,
    runId: context.runId,
    threadId: context.threadId,
    turnId: context.turnId,
    ...(details ? { details } : {}),
  };
}

export function emitDeliveryAudit(event: DeliveryAuditEvent): void {
  logger.info({ ...event }, event.name);
}

export function createDeliveryAuditLogger(
  context: DeliveryAuditContext,
  emit: (event: DeliveryAuditEvent) => void = emitDeliveryAudit,
) {
  return {
    finalSent(text: string) {
      emit(
        createDeliveryAuditEvent(context, 'delivery.final_sent', {
          textLength: text.length,
        }),
      );
    },
    finalReplaced(text: string) {
      emit(
        createDeliveryAuditEvent(context, 'delivery.final_replaced', {
          textLength: text.length,
        }),
      );
    },
    finalSuppressed(reason: string) {
      emit(
        createDeliveryAuditEvent(context, 'delivery.final_suppressed', {
          reason,
        }),
      );
    },
    finalFailed(error: string) {
      emit(
        createDeliveryAuditEvent(context, 'delivery.final_failed', {
          error,
        }),
      );
    },
  };
}

export function createRunnerOutputAuditLoggerFactory(
  context: DeliveryAuditRunContext,
  getLatestThreadId: () => string | null,
  emit: (event: DeliveryAuditEvent) => void = emitDeliveryAudit,
) {
  return (output: RunnerOutput) =>
    createDeliveryAuditLogger(
      {
        ...context,
        threadId: output.threadId ?? output.newSessionId ?? getLatestThreadId(),
        turnId: output.turnId,
      },
      emit,
    );
}
