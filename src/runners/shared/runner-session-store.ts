import {
  backfillRunnerSessionsFromLegacySessions,
  deleteRunnerSession as deleteDbRunnerSession,
  getAllRunnerSessions,
  getRunnerSession as getDbRunnerSession,
  setRunnerSession as setDbRunnerSession,
} from '../../db.js';

export type RunnerSessionKind = 'claude' | 'codex';

export function getRunnerSession(
  runnerKind: RunnerSessionKind,
  groupFolder: string,
): string | undefined {
  return getDbRunnerSession(runnerKind, groupFolder);
}

export function setRunnerSession(
  runnerKind: RunnerSessionKind,
  groupFolder: string,
  sessionId: string,
): void {
  setDbRunnerSession(runnerKind, groupFolder, sessionId);
}

export function clearRunnerSession(
  runnerKind: RunnerSessionKind,
  groupFolder: string,
): void {
  deleteDbRunnerSession(runnerKind, groupFolder);
}

export function getRunnerSessions(
  runnerKind: RunnerSessionKind,
): Record<string, string> {
  return getAllRunnerSessions(runnerKind);
}

export function backfillLegacyClaudeSessions(): number {
  return backfillRunnerSessionsFromLegacySessions();
}
