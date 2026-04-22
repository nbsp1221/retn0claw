import fs from 'fs';
import path from 'path';

import { readCodexOAuthTokens } from './codex-auth-store.js';
import { CODEX_EFFORT, CODEX_MODEL } from './config.js';
import {
  CodexAppServerClient,
  type CodexAppServerInput,
} from './codex-app-server-client.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';

interface RunnerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
}

interface RunnerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = '---RETN0CLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---RETN0CLAW_OUTPUT_END---';
const IPC_POLL_MS = 1000;

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
  const groupDir = resolveGroupFolderPath(input.groupFolder);
  const ipcDir = resolveGroupIpcPath(input.groupFolder);
  const ipcInputDir = path.join(ipcDir, 'input');
  fs.mkdirSync(ipcInputDir, { recursive: true });

  const client = new CodexAppServerClient({
    cwd: groupDir,
    getTokens: () => readCodexOAuthTokens(),
    log: (message) => console.error(message),
  });

  let activeInterrupt: (() => Promise<void>) | null = null;
  let activeWait: Promise<unknown> | null = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (activeInterrupt) {
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
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });

  try {
    await client.start();
    await client.login();
  } catch (error) {
    writeOutput({
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
      threadId = await client.startOrResumeThread(input.sessionId, {
        cwd: groupDir,
      });
    } catch (error) {
      if (!input.sessionId) throw error;
      threadId = await client.startOrResumeThread(undefined, {
        cwd: groupDir,
      });
    }
  } catch (error) {
    writeOutput({
      status: 'error',
      result: null,
      error: error instanceof Error ? error.message : String(error),
    });
    await client.close();
    return;
  }
  writeOutput({
    status: 'success',
    result: null,
    newSessionId: threadId,
  });

  let nextPrompt: string | null = input.prompt;
  let shouldExit = false;

  while (!shouldExit) {
    if (nextPrompt) {
      const turn = await client.startTurn(
        threadId,
        parseInputItems(nextPrompt),
        {
          cwd: groupDir,
          model: CODEX_MODEL || undefined,
          effort: CODEX_EFFORT || undefined,
          onProgress: (message) => {
            if (!message.trim()) return;
            writeOutput({
              status: 'success',
              result: message,
              newSessionId: threadId,
            });
          },
        },
      );

      let turnDone = false;
      const waitForTurn = turn.wait().then((result) => {
        turnDone = true;
        return result;
      });
      activeInterrupt = turn.interrupt;
      activeWait = waitForTurn;

      while (!turnDone) {
        if (consumeCloseSentinel(ipcInputDir)) {
          shouldExit = true;
          await waitForTurnCompletionWithTimeout(turn.interrupt(), 2000);
          break;
        }

        const queued = readQueuedMessages(ipcInputDir);
        if (queued.length > 0) {
          try {
            await turn.steer(parseInputItems(queued.map((q) => q.text).join('\n')));
            acknowledgeQueuedMessages(queued);
          } catch (error) {
            console.error(
              `[codex-runner-process] steer failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            await sleep(IPC_POLL_MS);
          }
        } else {
          await sleep(IPC_POLL_MS);
        }
      }

      const turnResult = shouldExit
        ? await waitForTurnCompletionWithTimeout(waitForTurn, 5000)
        : await waitForTurn;
      activeInterrupt = null;
      activeWait = null;
      if (!turnResult) {
        writeOutput({
          status: 'error',
          result: null,
          newSessionId: threadId,
          error: 'Timed out waiting for interrupted Codex turn to finish',
        });
        break;
      }
      if (turnResult.status === 'failed') {
        writeOutput({
          status: 'error',
          result: turnResult.result,
          newSessionId: threadId,
          error: turnResult.error || 'Codex turn failed',
        });
        break;
      }

      writeOutput({
        status: 'success',
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
