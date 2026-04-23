import { logger } from '../../logger.js';
import type { RunnerKind } from '../shared/runner.js';

export interface CodexCorrelationContext {
  groupFolder: string | null;
  chatJid: string | null;
  runnerKind: RunnerKind | null;
  runId: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface CodexDiagnosticEvent extends CodexCorrelationContext {
  name: string;
  details?: Record<string, unknown>;
}

function withBase(
  context: CodexCorrelationContext,
  name: string,
  details?: Record<string, unknown>,
): CodexDiagnosticEvent {
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

function elapsedMs(startedAt: string, observedAt: string): number {
  return Math.max(
    0,
    new Date(observedAt).getTime() - new Date(startedAt).getTime(),
  );
}

export function createCodexDiagnostics(context: CodexCorrelationContext) {
  return {
    runStarted() {
      return withBase(context, 'codex.run.started');
    },
    runProgress(details?: Record<string, unknown>) {
      return withBase(context, 'codex.run.progress', details);
    },
    runToolActivity(summary: string) {
      return withBase(context, 'codex.run.tool_activity', { summary });
    },
    runCompleted(details?: Record<string, unknown>) {
      return withBase(context, 'codex.run.completed', details);
    },
    runFailed(error: string) {
      return withBase(context, 'codex.run.failed', { error });
    },
    runParseFailure(error: string) {
      return withBase(context, 'codex.run.parse_failure', { error });
    },
    runInterrupted(details?: Record<string, unknown>) {
      return withBase(context, 'codex.run.interrupted', details);
    },
    sessionResumeAttempted(sessionId: string) {
      return withBase(context, 'codex.session.resume_attempted', { sessionId });
    },
    sessionResumeFailed(sessionId: string, error: string) {
      return withBase(context, 'codex.session.resume_failed', {
        sessionId,
        error,
      });
    },
    sessionReplaced(previousSessionId: string | null, nextSessionId: string) {
      return withBase(context, 'codex.session.replaced', {
        previousSessionId,
        nextSessionId,
      });
    },
    sessionStuck(details: {
      startedAt: string;
      observedAt: string;
      reason: string;
    }) {
      return withBase(context, 'codex.session.stuck', {
        ...details,
        elapsedMs: elapsedMs(details.startedAt, details.observedAt),
      });
    },
  };
}

export function emitCodexDiagnostic(event: CodexDiagnosticEvent): void {
  logger.info({ ...event }, event.name);
}
