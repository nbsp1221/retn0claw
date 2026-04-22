import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('close', 0);
    return true;
  }
}

const spawnMock = vi.fn();

vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

describe('codex runner host adapter', () => {
  beforeEach(() => {
    vi.resetModules();
    spawnMock.mockReset();
  });

  it('spawns the codex runner process, streams outputs, and returns the final result', async () => {
    const proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);

    const mod = await import('./codex-runner.js');

    const onOutput = vi.fn(async () => {});
    const onProcess = vi.fn();

    const runPromise = mod.runCodexAgent(
      {
        name: 'Codex Group',
        folder: 'codex-group',
        trigger: '@Andy',
        added_at: '2026-04-22T00:00:00.000Z',
      },
      {
        prompt: 'hello',
        sessionId: 'thread-1',
        groupFolder: 'codex-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      onProcess,
      onOutput,
    );

    proc.stdout.write(
      '---RETN0CLAW_OUTPUT_START---' +
        JSON.stringify({
          status: 'success',
          result: 'partial',
          newSessionId: 'thread-1',
        }) +
        '---RETN0CLAW_OUTPUT_END---',
    );
    proc.stdout.write(
      '---RETN0CLAW_OUTPUT_START---' +
        JSON.stringify({
          status: 'success',
          result: 'final',
          newSessionId: 'thread-2',
        }) +
        '---RETN0CLAW_OUTPUT_END---',
    );
    proc.emit('close', 0);

    await expect(runPromise).resolves.toEqual({
      status: 'success',
      result: 'final',
      newSessionId: 'thread-2',
    });

    expect(onProcess).toHaveBeenCalledWith(
      proc,
      expect.stringContaining('codex-group'),
    );
    expect(onOutput).toHaveBeenCalledTimes(2);
  });
});
