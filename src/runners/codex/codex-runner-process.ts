import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { readCodexOAuthTokens } from './codex-auth-store.js';
import { CODEX_EFFORT, CODEX_MODEL } from '../../config.js';
import {
  CodexAppServerClient,
  type CodexAppServerInput,
  type CodexAppServerTurnResult,
} from './codex-app-server-client.js';
import {
  resolveGroupFolderPath,
  resolveGroupIpcPath,
} from '../../group-folder.js';

interface RunnerInput {
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

interface RunnerOutput {
  status: 'success' | 'error';
  eventKind?:
    | 'turn_started'
    | 'progress'
    | 'final'
    | 'turn_failed'
    | 'turn_interrupted'
    | 'meta';
  phase?: 'progress' | 'final' | 'meta';
  threadId?: string | null;
  turnId?: string | null;
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface RunnerProcessTurn {
  turnId: string;
  steer: (nextInput: CodexAppServerInput[]) => Promise<void>;
  interrupt: () => Promise<void>;
  wait: () => Promise<CodexAppServerTurnResult>;
}

interface RunnerProcessClient {
  start(): Promise<void>;
  login(): Promise<void>;
  close(): Promise<void>;
  startOrResumeThread(
    sessionId: string | undefined,
    options: { cwd: string },
  ): Promise<string>;
  startTurn(
    threadId: string,
    input: CodexAppServerInput[],
    options: {
      cwd: string;
      model?: string;
      effort?: string;
      onProgress?: (message: string, turnId: string) => void;
    },
  ): Promise<RunnerProcessTurn>;
  recordHostEvent(
    payload: unknown,
    ids?: { threadId?: string | null; turnId?: string | null },
  ): void;
  emitRunStarted(details?: Record<string, unknown>): void;
  emitSessionResumeAttempted(sessionId: string): void;
  emitSessionResumeFailed(sessionId: string, error: string): void;
  emitSessionReplaced(
    previousSessionId: string | null,
    nextSessionId: string,
  ): void;
  emitSessionStuck(details: {
    startedAt: string;
    observedAt: string;
    reason: string;
  }): void;
}

interface RunnerProcessDeps {
  resolveGroupFolderPath?: (folder: string) => string;
  resolveGroupIpcPath?: (folder: string) => string;
  createClient?: (args: {
    groupDir: string;
    input: RunnerInput;
    runId: string;
  }) => RunnerProcessClient;
  writeOutput?: (output: RunnerOutput) => void;
  sleep?: (ms: number) => Promise<void>;
  registerSignalHandler?: (
    signal: 'SIGTERM' | 'SIGINT',
    handler: () => void,
  ) => void;
  exitProcess?: (code: number) => void;
}

const OUTPUT_START_MARKER = '---RETN0CLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---RETN0CLAW_OUTPUT_END---';
const IPC_POLL_MS = 1000;
const STUCK_OBSERVABILITY_MS = parseInt(
  process.env.CODEX_STUCK_OBSERVABILITY_MS || '60000',
  10,
);

function writeOutput(output: RunnerOutput): void {
  process.stdout.write(
    `${OUTPUT_START_MARKER}${JSON.stringify(output)}${OUTPUT_END_MARKER}`,
  );
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForTurnCompletionWithTimeout<T>(
  waitForTurn: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  return Promise.race([waitForTurn, sleep(timeoutMs).then(() => null)]);
}

function parseInputItems(text: string): CodexAppServerInput[] {
  return [{ type: 'text', text, text_elements: [] }];
}

function consumeCloseSentinel(inputDir: string): boolean {
  const sentinel = path.join(inputDir, '_close');
  if (!fs.existsSync(sentinel)) return false;
  try {
    fs.unlinkSync(sentinel);
  } catch {
    /* ignore */
  }
  return true;
}

interface QueuedMessageEntry {
  filePath: string;
  text: string;
}

function readQueuedMessages(inputDir: string): QueuedMessageEntry[] {
  fs.mkdirSync(inputDir, { recursive: true });
  const files = fs
    .readdirSync(inputDir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  const messages: QueuedMessageEntry[] = [];
  for (const file of files) {
    const filePath = path.join(inputDir, file);
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (payload.type === 'message' && payload.text) {
        messages.push({
          filePath,
          text: String(payload.text),
        });
      }
    } catch (error) {
      console.error(
        `[codex-runner-process] failed to read input ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      try {
        fs.unlinkSync(filePath);
      } catch {
        /* ignore */
      }
    }
  }
  return messages;
}

function acknowledgeQueuedMessages(messages: QueuedMessageEntry[]): void {
  for (const message of messages) {
    try {
      fs.unlinkSync(message.filePath);
    } catch {
      /* ignore */
    }
  }
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw) as RunnerInput;
  await runCodexRunnerProcess(input);
}

export async function runCodexRunnerProcess(
  input: RunnerInput,
  deps: RunnerProcessDeps = {},
): Promise<void> {
  const write = deps.writeOutput || writeOutput;
  const sleepFn = deps.sleep || sleep;
  const registerSignalHandler =
    deps.registerSignalHandler ||
    ((signal: 'SIGTERM' | 'SIGINT', handler: () => void) => {
      process.on(signal, handler);
    });
  const exitProcess =
    deps.exitProcess || ((code: number) => process.exit(code));
  const resolveGroupDir = deps.resolveGroupFolderPath || resolveGroupFolderPath;
  const resolveIpcDir = deps.resolveGroupIpcPath || resolveGroupIpcPath;
  const groupDir = resolveGroupDir(input.groupFolder);
  const ipcDir = resolveIpcDir(input.groupFolder);
  const ipcInputDir = path.join(ipcDir, 'input');
  const runId = input.runId || randomUUID();
  fs.mkdirSync(ipcInputDir, { recursive: true });

  const client =
    deps.createClient?.({ groupDir, input, runId }) ||
    new CodexAppServerClient({
      cwd: groupDir,
      getTokens: () => readCodexOAuthTokens(),
      log: (message) => console.error(message),
      observability: {
        groupFolder: input.groupFolder,
        chatJid: input.chatJid,
        runnerKind: 'codex',
        runId,
        threadId: input.sessionId || null,
        turnId: null,
        log: (message) => console.error(message),
      },
    });

  let activeInterrupt: (() => Promise<void>) | null = null;
  let activeWait: Promise<unknown> | null = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (activeInterrupt) {
        client.recordHostEvent({ type: 'interrupt_requested' });
        await activeInterrupt();
        if (activeWait) {
          await waitForTurnCompletionWithTimeout(activeWait, 5000);
        }
      }
    } catch {
      /* ignore */
    }
    activeInterrupt = null;
    activeWait = null;
    await client.close();
    exitProcess(0);
  };
  registerSignalHandler('SIGTERM', () => {
    void shutdown();
  });
  registerSignalHandler('SIGINT', () => {
    void shutdown();
  });

  try {
    await client.start();
    await client.login();
    client.emitRunStarted({
      promptLength: input.prompt.length,
      groupDir,
    });
  } catch (error) {
    write({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    await client.close();
    return;
  }

  let threadId = '';
  try {
    try {
      if (input.sessionId) {
        client.emitSessionResumeAttempted(input.sessionId);
      }
      threadId = await client.startOrResumeThread(input.sessionId, {
        cwd: groupDir,
      });
    } catch (error) {
      if (!input.sessionId) throw error;
      client.emitSessionResumeFailed(
        input.sessionId,
        error instanceof Error ? error.message : String(error),
      );
      threadId = await client.startOrResumeThread(undefined, {
        cwd: groupDir,
      });
      client.emitSessionReplaced(input.sessionId, threadId);
    }
  } catch (error) {
    write({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    await client.close();
    return;
  }
  write({
    status: 'success',
    eventKind: 'meta',
    phase: 'meta',
    threadId,
    turnId: null,
    result: null,
    newSessionId: threadId,
  });

  let nextPrompt: string | null = input.prompt;
  let shouldExit = false;

  while (!shouldExit) {
    if (nextPrompt) {
      const turnStartedAt = new Date().toISOString();
      const turn = await client.startTurn(
        threadId,
        parseInputItems(nextPrompt),
        {
          cwd: groupDir,
          model: CODEX_MODEL || undefined,
          effort: CODEX_EFFORT || undefined,
          onProgress: (message, progressTurnId) => {
            if (!message.trim()) return;
            write({
              status: 'success',
              eventKind: 'progress',
              phase: 'progress',
              threadId,
              turnId: progressTurnId,
              result: message,
              newSessionId: threadId,
            });
          },
        },
      );
      write({
        status: 'success',
        eventKind: 'turn_started',
        phase: 'meta',
        threadId,
        turnId: turn.turnId,
        result: null,
        newSessionId: threadId,
      });
      client.recordHostEvent(
        {
          type: 'turn_started',
          runId,
          threadId,
        },
        { threadId, turnId: turn.turnId },
      );

      let turnDone = false;
      const waitForTurn = turn.wait().then((result) => {
        turnDone = true;
        return result;
      });
      const stuckTimer = setTimeout(() => {
        if (turnDone) return;
        client.emitSessionStuck({
          startedAt: turnStartedAt,
          observedAt: new Date().toISOString(),
          reason: 'no_terminal_event',
        });
      }, STUCK_OBSERVABILITY_MS);
      stuckTimer.unref?.();
      activeInterrupt = turn.interrupt;
      activeWait = waitForTurn;

      while (!turnDone) {
        if (consumeCloseSentinel(ipcInputDir)) {
          shouldExit = true;
          client.recordHostEvent(
            { type: 'close_sentinel_consumed' },
            { threadId, turnId: turn.turnId },
          );
          await waitForTurnCompletionWithTimeout(turn.interrupt(), 2000);
          break;
        }

        const queued = readQueuedMessages(ipcInputDir);
        if (queued.length > 0) {
          try {
            for (const entry of queued) {
              await turn.steer(parseInputItems(entry.text));
              acknowledgeQueuedMessages([entry]);
            }
          } catch (error) {
            console.error(
              `[codex-runner-process] steer failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            await sleepFn(IPC_POLL_MS);
          }
        } else {
          await sleepFn(IPC_POLL_MS);
        }
      }

      const turnResult = shouldExit
        ? await waitForTurnCompletionWithTimeout(waitForTurn, 5000)
        : await waitForTurn;
      clearTimeout(stuckTimer);
      activeInterrupt = null;
      activeWait = null;
      if (!turnResult) {
        write({
          status: 'error',
          eventKind: 'turn_interrupted',
          phase: 'final',
          threadId,
          turnId: turn.turnId,
          result: null,
          newSessionId: threadId,
          error: 'Timed out waiting for interrupted Codex turn to finish',
        });
        break;
      }
      if (turnResult.status === 'failed') {
        write({
          status: 'error',
          eventKind: 'turn_failed',
          phase: 'final',
          threadId,
          turnId: turn.turnId,
          result: turnResult.result,
          newSessionId: threadId,
          error: turnResult.error || 'Codex turn failed',
        });
        break;
      }
      if (turnResult.status === 'interrupted') {
        write({
          status: 'error',
          eventKind: 'turn_interrupted',
          phase: 'final',
          threadId,
          turnId: turn.turnId,
          result: turnResult.result,
          newSessionId: threadId,
        });
        if (shouldExit) {
          break;
        }
        nextPrompt = null;
        continue;
      }

      write({
        status: 'success',
        eventKind: 'final',
        phase: 'final',
        threadId,
        turnId: turn.turnId,
        result: turnResult.result,
        newSessionId: threadId,
      });

      nextPrompt = null;
      continue;
    }

    if (consumeCloseSentinel(ipcInputDir)) {
      break;
    }

    const queued = readQueuedMessages(ipcInputDir);
    if (queued.length > 0) {
      nextPrompt = queued.map((q) => q.text).join('\n');
      acknowledgeQueuedMessages(queued);
      continue;
    }

    await sleep(IPC_POLL_MS);
  }

  await client.close();
}

const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((error) => {
    writeOutput({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
