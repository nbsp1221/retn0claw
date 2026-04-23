import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('codex runner process helper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when interrupted turn completion exceeds the timeout', async () => {
    const mod = await import('./codex-runner-process.js');

    const pending = new Promise<never>(() => {});
    const resultPromise = mod.waitForTurnCompletionWithTimeout(pending, 5000);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toBeNull();
  });

  it('emits live runner-process observability on resume failure and stuck turn', async () => {
    vi.useRealTimers();
    vi.resetModules();
    process.env.CODEX_STUCK_OBSERVABILITY_MS = '5';
    const mod = await import('./codex-runner-process.js');
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'codex-runner-process-'),
    );
    const groupDir = path.join(rootDir, 'group');
    const ipcDir = path.join(rootDir, 'ipc');
    const inputDir = path.join(ipcDir, 'input');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });

    const outputs: unknown[] = [];
    const calls: string[] = [];
    let interrupted = false;
    let sleepCalls = 0;

    try {
      const runPromise = mod.runCodexRunnerProcess(
        {
          prompt: '환경 보고',
          sessionId: 'thread-stale',
          runId: 'run-1',
          groupFolder: 'group',
          chatJid: 'tg:1',
          isMain: false,
        },
        {
          resolveGroupFolderPath: () => groupDir,
          resolveGroupIpcPath: () => ipcDir,
          writeOutput: (output) => outputs.push(output),
          sleep: async () => {
            sleepCalls += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (
              sleepCalls >= 2 &&
              !fs.existsSync(path.join(inputDir, '_close'))
            ) {
              fs.writeFileSync(path.join(inputDir, '_close'), '');
            }
          },
          createClient: () => ({
            async start() {},
            async login() {},
            async close() {},
            async startOrResumeThread(sessionId?: string) {
              if (sessionId) throw new Error('session not found');
              return 'thread-new';
            },
            async startTurn(_threadId, _input, _options) {
              _options.onProgress?.('partial progress', 'turn-1');
              return {
                turnId: 'turn-1',
                async steer() {},
                async interrupt() {
                  interrupted = true;
                },
                async wait() {
                  while (!interrupted) {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                  }
                  return { status: 'interrupted', result: null };
                },
              };
            },
            recordHostEvent(payload) {
              calls.push(`host:${JSON.stringify(payload)}`);
            },
            emitRunStarted() {
              calls.push('run_started');
            },
            emitSessionResumeAttempted(sessionId) {
              calls.push(`resume_attempted:${sessionId}`);
            },
            emitSessionResumeFailed(sessionId, error) {
              calls.push(`resume_failed:${sessionId}:${error}`);
            },
            emitSessionReplaced(previousSessionId, nextSessionId) {
              calls.push(
                `session_replaced:${previousSessionId}->${nextSessionId}`,
              );
            },
            emitSessionStuck(details) {
              calls.push(`session_stuck:${details.reason}`);
            },
          }),
        },
      );

      await runPromise;

      expect(calls).toEqual(
        expect.arrayContaining([
          'run_started',
          'resume_attempted:thread-stale',
          'resume_failed:thread-stale:session not found',
          'session_replaced:thread-stale->thread-new',
          'session_stuck:no_terminal_event',
          'host:{"type":"close_sentinel_consumed"}',
        ]),
      );
      expect(outputs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: 'progress',
            result: 'partial progress',
          }),
          expect.objectContaining({
            phase: 'meta',
            newSessionId: 'thread-new',
          }),
        ]),
      );
    } finally {
      delete process.env.CODEX_STUCK_OBSERVABILITY_MS;
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('records interrupt_requested when shutdown is triggered by a signal', async () => {
    vi.useRealTimers();
    vi.resetModules();
    const mod = await import('./codex-runner-process.js');
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'codex-runner-signal-'),
    );
    const groupDir = path.join(rootDir, 'group');
    const ipcDir = path.join(rootDir, 'ipc');
    const inputDir = path.join(ipcDir, 'input');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(inputDir, { recursive: true });

    const calls: string[] = [];
    const signalHandlers = new Map<'SIGTERM' | 'SIGINT', () => void>();
    let interrupted = false;
    let exited = false;
    let turnReadyResolve: (() => void) | null = null;
    const turnReady = new Promise<void>((resolve) => {
      turnReadyResolve = resolve;
    });
    let interruptReadyResolve: (() => void) | null = null;
    const interruptReady = new Promise<void>((resolve) => {
      interruptReadyResolve = resolve;
    });

    try {
      const runPromise = mod.runCodexRunnerProcess(
        {
          prompt: '환경 보고',
          sessionId: 'thread-existing',
          runId: 'run-signal',
          groupFolder: 'group',
          chatJid: 'tg:1',
          isMain: false,
        },
        {
          resolveGroupFolderPath: () => groupDir,
          resolveGroupIpcPath: () => ipcDir,
          registerSignalHandler: (signal, handler) => {
            signalHandlers.set(signal, handler);
          },
          exitProcess: () => {
            exited = true;
          },
          createClient: () => ({
            async start() {},
            async login() {},
            async close() {},
            async startOrResumeThread() {
              return 'thread-existing';
            },
            async startTurn(_threadId, _input, _options) {
              turnReadyResolve?.();
              return {
                turnId: 'turn-signal',
                async steer() {},
                async interrupt() {
                  interrupted = true;
                },
                async wait() {
                  while (!interrupted) {
                    await new Promise((resolve) => setTimeout(resolve, 1));
                  }
                  return { status: 'interrupted', result: null };
                },
              };
            },
            recordHostEvent(payload) {
              calls.push(`host:${JSON.stringify(payload)}`);
              if (
                payload &&
                typeof payload === 'object' &&
                'type' in payload &&
                payload.type === 'turn_started'
              ) {
                interruptReadyResolve?.();
              }
            },
            emitRunStarted() {
              calls.push('run_started');
            },
            emitSessionResumeAttempted() {},
            emitSessionResumeFailed() {},
            emitSessionReplaced() {},
            emitSessionStuck() {},
          }),
        },
      );

      await turnReady;
      await interruptReady;
      signalHandlers.get('SIGTERM')?.();
      fs.writeFileSync(path.join(inputDir, '_close'), '');
      await runPromise;

      expect(calls).toContain('host:{"type":"interrupt_requested"}');
      expect(exited).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
