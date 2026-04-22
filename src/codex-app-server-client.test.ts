import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexOAuthTokens } from './codex-auth-store.js';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.emit('close', signal === 'SIGKILL' ? 137 : 0);
    return true;
  }
}

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

function createHarness() {
  const proc = new FakeChildProcess();
  const messages: RpcMessage[] = [];
  let stdoutBuffer = '';

  proc.stdin.setEncoding('utf8');
  proc.stdin.on('data', (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      messages.push(JSON.parse(trimmed));
    }
  });

  const send = (payload: unknown) => {
    proc.stdout.write(`${JSON.stringify(payload)}\n`);
  };

  return { proc, messages, send };
}

describe('codex app-server client', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('initializes and logs in with host-managed chatgptAuthTokens', async () => {
    const harness = createHarness();
    const getTokens = vi.fn<() => CodexOAuthTokens>().mockReturnValue({
      idToken: 'id-token',
      accessToken: 'access-token',
      chatgptAccountId: 'account-123',
      chatgptPlanType: 'plus',
    });

    const mod = await import('./codex-app-server-client.js');
    const client = new mod.CodexAppServerClient({
      cwd: '/tmp/project',
      getTokens,
      log: vi.fn(),
      spawnAppServer: () => harness.proc as any,
    });

    const startPromise = client.start();

    harness.send({ id: 1, result: { ok: true } });
    await startPromise;

    const loginPromise = client.login();
    harness.send({ id: 2, result: { type: 'chatgptAuthTokens' } });
    harness.send({
      method: 'account/login/completed',
      params: { loginId: null, success: true, error: null },
    });
    await loginPromise;

    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'initialize' }),
        expect.objectContaining({ method: 'initialized' }),
        expect.objectContaining({
          method: 'account/login/start',
          params: expect.objectContaining({
            type: 'chatgptAuthTokens',
            idToken: 'id-token',
            accessToken: 'access-token',
            chatgptAccountId: 'account-123',
            chatgptPlanType: 'plus',
          }),
        }),
      ]),
    );
  });

  it('handles token refresh requests and turn steering', async () => {
    const harness = createHarness();
    const getTokens = vi
      .fn<() => CodexOAuthTokens>()
      .mockReturnValueOnce({
        idToken: 'id-token',
        accessToken: 'access-token',
        chatgptAccountId: 'account-123',
        chatgptPlanType: 'plus',
      })
      .mockReturnValueOnce({
        idToken: 'refreshed-id-token',
        accessToken: 'refreshed-access-token',
        chatgptAccountId: 'account-123',
        chatgptPlanType: 'plus',
      });

    const mod = await import('./codex-app-server-client.js');
    const client = new mod.CodexAppServerClient({
      cwd: '/tmp/project',
      getTokens,
      log: vi.fn(),
      spawnAppServer: () => harness.proc as any,
    });

    const startPromise = client.start();
    harness.send({ id: 1, result: { ok: true } });
    await startPromise;

    const loginPromise = client.login();
    harness.send({ id: 2, result: { type: 'chatgptAuthTokens' } });
    harness.send({
      method: 'account/login/completed',
      params: { loginId: null, success: true, error: null },
    });
    await loginPromise;

    const threadPromise = client.startOrResumeThread(undefined, {
      cwd: '/tmp/project',
    });
    harness.send({ id: 3, result: { thread: { id: 'thread-1' } } });
    await expect(threadPromise).resolves.toBe('thread-1');

    const startTurnPromise = client.startTurn(
      'thread-1',
      [{ type: 'text', text: 'hello', text_elements: [] }],
      { cwd: '/tmp/project', onProgress: vi.fn() },
    );
    harness.send({ id: 4, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
    const turn = await startTurnPromise;

    harness.send({
      method: 'account/chatgptAuthTokens/refresh',
      id: 99,
      params: { reason: 'unauthorized', previousAccountId: 'account-123' },
    });

    const steerPromise = turn.steer([
      { type: 'text', text: 'follow-up', text_elements: [] },
    ]);
    harness.send({ id: 5, result: { turnId: 'turn-1' } });
    await steerPromise;

    harness.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-1',
        item: { type: 'agentMessage', id: 'item-1', text: 'final result', phase: null, memoryCitation: null },
      },
    });
    harness.send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          items: [],
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      },
    });

    await expect(turn.wait()).resolves.toEqual(
      expect.objectContaining({
        result: 'final result',
      }),
    );

    expect(harness.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 99,
          result: expect.objectContaining({
            idToken: 'refreshed-id-token',
            accessToken: 'refreshed-access-token',
            chatgptAccountId: 'account-123',
            chatgptPlanType: 'plus',
          }),
        }),
        expect.objectContaining({
          method: 'turn/steer',
          params: expect.objectContaining({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
          }),
        }),
      ]),
    );
  });

  it('clears the active turn state when turn/start fails so later turns can proceed', async () => {
    const harness = createHarness();
    const getTokens = vi.fn<() => CodexOAuthTokens>().mockReturnValue({
      idToken: 'id-token',
      accessToken: 'access-token',
      chatgptAccountId: 'account-123',
      chatgptPlanType: 'plus',
    });

    const mod = await import('./codex-app-server-client.js');
    const client = new mod.CodexAppServerClient({
      cwd: '/tmp/project',
      getTokens,
      log: vi.fn(),
      spawnAppServer: () => harness.proc as any,
    });

    const startPromise = client.start();
    harness.send({ id: 1, result: { ok: true } });
    await startPromise;

    const loginPromise = client.login();
    harness.send({ id: 2, result: { type: 'chatgptAuthTokens' } });
    harness.send({
      method: 'account/login/completed',
      params: { loginId: null, success: true, error: null },
    });
    await loginPromise;

    const threadPromise = client.startOrResumeThread(undefined, {
      cwd: '/tmp/project',
    });
    harness.send({ id: 3, result: { thread: { id: 'thread-1' } } });
    await expect(threadPromise).resolves.toBe('thread-1');

    const failedStartTurn = client.startTurn(
      'thread-1',
      [{ type: 'text', text: 'first', text_elements: [] }],
      { cwd: '/tmp/project' },
    );
    harness.send({
      id: 4,
      error: { message: 'turn/start failed' },
    });
    await expect(failedStartTurn).rejects.toThrow(/turn\/start failed/i);

    const secondTurnPromise = client.startTurn(
      'thread-1',
      [{ type: 'text', text: 'second', text_elements: [] }],
      { cwd: '/tmp/project' },
    );
    harness.send({ id: 5, result: { turn: { id: 'turn-2', status: 'inProgress' } } });
    const secondTurn = await secondTurnPromise;
    harness.send({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-2',
        item: { type: 'agentMessage', id: 'item-2', text: 'OK', phase: null, memoryCitation: null },
      },
    });
    harness.send({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-2',
          items: [],
          status: 'completed',
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      },
    });
    await expect(secondTurn.wait()).resolves.toEqual(
      expect.objectContaining({ result: 'OK' }),
    );
  });
});
