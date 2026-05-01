import type { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';

import { DEFAULT_RUNNER } from '../../config.js';
import { runContainerAgent } from '../claude/container-runner.js';
import { runCodexAgent } from '../codex/codex-runner.js';
import { logger } from '../../logger.js';
import {
  type AvailableGroup,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './runner-artifacts.js';
import type { RegisteredGroup } from '../../types.js';

export interface RunnerTaskSnapshot {
  id: string;
  groupFolder: string;
  prompt: string;
  script?: string | null;
  schedule_type: string;
  schedule_value: string;
  status: string;
  next_run: string | null;
}

export interface RunnerGroupsSnapshot {
  availableGroups: AvailableGroup[];
  registeredJids: Set<string>;
}

export interface RunnerSessionStore {
  get(): string | undefined;
  set(sessionId: string): void;
  clear(): void;
}

export interface RunnerInput {
  prompt: string;
  sessionId?: string;
  runId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

export type RunnerEventKind =
  | 'turn_started'
  | 'progress'
  | 'final'
  | 'turn_failed'
  | 'turn_interrupted'
  | 'meta';

export interface RunnerOutput {
  status: 'success' | 'error';
  eventKind: RunnerEventKind;
  phase?: 'progress' | 'final' | 'meta';
  threadId: string | null;
  turnId: string | null;
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export function isTerminalRunnerOutput(output: RunnerOutput): boolean {
  return (
    output.eventKind === 'final' ||
    output.eventKind === 'turn_failed' ||
    output.eventKind === 'turn_interrupted'
  );
}

interface AdapterRunnerOutput {
  status: 'success' | 'error';
  phase?: 'progress' | 'final' | 'meta';
  eventKind?: RunnerEventKind;
  threadId?: string | null;
  turnId?: string | null;
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface RunnerNormalizationContext {
  syntheticTurnId: string;
  lastThreadId: string | null;
}

function inferEventKind(output: AdapterRunnerOutput): RunnerEventKind {
  if (output.eventKind) {
    return output.eventKind;
  }
  if (output.phase === 'meta') {
    return 'meta';
  }
  if (output.phase === 'progress') {
    return 'progress';
  }
  return output.status === 'error' ? 'turn_failed' : 'final';
}

function normalizeRunnerOutput(
  output: AdapterRunnerOutput,
  context: RunnerNormalizationContext,
): RunnerOutput {
  const eventKind = inferEventKind(output);
  const threadId =
    output.threadId ?? output.newSessionId ?? context.lastThreadId ?? null;

  if (threadId) {
    context.lastThreadId = threadId;
  }

  return {
    status: output.status,
    eventKind,
    phase: output.phase,
    threadId,
    turnId:
      output.turnId ?? (eventKind === 'meta' ? null : context.syntheticTurnId),
    result: output.result,
    newSessionId: output.newSessionId,
    error: output.error,
  };
}

export type RunnerKind = 'claude' | 'codex';

export function createSyntheticTurnId(
  runnerKind: RunnerKind,
  runId: string | undefined,
): string {
  return `${runnerKind}:${runId ?? randomUUID()}:synthetic-turn`;
}

export interface RunDefaultRunnerArgs {
  group: RegisteredGroup;
  input: Omit<RunnerInput, 'sessionId'> & { sessionId?: string };
  session: RunnerSessionStore;
  tasksSnapshot?: RunnerTaskSnapshot[];
  groupsSnapshot?: RunnerGroupsSnapshot;
  onProcess: (proc: ChildProcess, runtimeHandle: string) => void;
  onOutput?: (output: RunnerOutput) => Promise<void>;
}

export interface Runner {
  run(args: RunDefaultRunnerArgs): Promise<RunnerOutput>;
}

function resolveRunnerKind(rawValue: string | undefined): RunnerKind {
  const normalized = rawValue?.trim().toLowerCase() || 'claude';
  if (normalized === 'claude' || normalized === 'codex') {
    return normalized;
  }
  throw new Error(
    `Invalid DEFAULT_RUNNER value "${rawValue}". Expected "claude" or "codex".`,
  );
}

export function getSelectedRunnerKind(): RunnerKind {
  return selectedRunnerKind;
}

const selectedRunnerKind = resolveRunnerKind(DEFAULT_RUNNER);

function isStaleSessionError(error: string | undefined): boolean {
  return Boolean(
    error &&
    /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(error),
  );
}

class ClaudeContainerRunner implements Runner {
  async run(args: RunDefaultRunnerArgs): Promise<RunnerOutput> {
    const {
      group,
      session,
      tasksSnapshot,
      groupsSnapshot,
      onProcess,
      onOutput,
    } = args;
    const input: RunnerInput = {
      ...args.input,
      sessionId: args.input.sessionId ?? session.get(),
    };
    const isMain = input.isMain === true;

    if (tasksSnapshot) {
      writeTasksSnapshot(input.groupFolder, isMain, tasksSnapshot);
    }

    if (groupsSnapshot) {
      writeGroupsSnapshot(
        input.groupFolder,
        isMain,
        groupsSnapshot.availableGroups,
        groupsSnapshot.registeredJids,
      );
    }

    const normalizationContext: RunnerNormalizationContext = {
      syntheticTurnId: createSyntheticTurnId('claude', input.runId),
      lastThreadId: input.sessionId ?? null,
    };

    const wrappedOnOutput = onOutput
      ? async (rawOutput: AdapterRunnerOutput) => {
          const output = normalizeRunnerOutput(rawOutput, normalizationContext);
          if (output.newSessionId) {
            session.set(output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    const rawResult = await runContainerAgent(
      group,
      input,
      onProcess,
      wrappedOnOutput,
    );
    const result = normalizeRunnerOutput(rawResult, normalizationContext);

    if (result.newSessionId) {
      session.set(result.newSessionId);
    }

    if (
      input.sessionId &&
      result.status === 'error' &&
      isStaleSessionError(result.error)
    ) {
      logger.warn(
        {
          group: group.name,
          staleSessionId: input.sessionId,
          error: result.error,
        },
        'Stale runner session detected — clearing for next retry',
      );
      session.clear();
    }

    return result;
  }
}

class CodexRunner implements Runner {
  async run(args: RunDefaultRunnerArgs): Promise<RunnerOutput> {
    const { group, session, onProcess, onOutput } = args;
    const input: RunnerInput = {
      ...args.input,
      sessionId: args.input.sessionId ?? session.get(),
    };
    const normalizationContext: RunnerNormalizationContext = {
      syntheticTurnId: createSyntheticTurnId('codex', input.runId),
      lastThreadId: input.sessionId ?? null,
    };

    const wrappedOnOutput = onOutput
      ? async (rawOutput: AdapterRunnerOutput) => {
          const output = normalizeRunnerOutput(rawOutput, normalizationContext);
          if (output.newSessionId) {
            session.set(output.newSessionId);
          }
          await onOutput(output);
        }
      : undefined;

    const rawResult = await runCodexAgent(
      group,
      input,
      onProcess,
      wrappedOnOutput,
    );
    const result = normalizeRunnerOutput(rawResult, normalizationContext);

    if (result.newSessionId) {
      session.set(result.newSessionId);
    }

    if (
      input.sessionId &&
      result.status === 'error' &&
      isStaleSessionError(result.error)
    ) {
      logger.warn(
        {
          group: group.name,
          staleSessionId: input.sessionId,
          error: result.error,
        },
        'Stale runner session detected — clearing for next retry',
      );
      session.clear();
    }

    return result;
  }
}

function createDefaultRunner(): Runner {
  return selectedRunnerKind === 'codex'
    ? new CodexRunner()
    : new ClaudeContainerRunner();
}

const defaultRunner: Runner = createDefaultRunner();

export async function runDefaultRunner(
  args: RunDefaultRunnerArgs,
): Promise<RunnerOutput> {
  return defaultRunner.run(args);
}
