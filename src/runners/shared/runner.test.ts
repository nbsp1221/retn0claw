import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../claude/container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../codex/codex-runner.js', () => ({
  runCodexAgent: vi.fn(),
}));

vi.mock('./runner-artifacts.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('runner dispatch seam', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.DEFAULT_RUNNER = 'claude';
  });

  it('prepares snapshots and persists streamed/final session ids through the host runner contract', async () => {
    const containerRunner = await import('../claude/container-runner.js');
    const runnerArtifacts = await import('./runner-artifacts.js');
    vi.mocked(containerRunner.runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: 'streamed',
          newSessionId: 'session-stream',
        });

        return {
          status: 'success',
          result: 'final',
          newSessionId: 'session-final',
        };
      },
    );

    const mod = await import('./runner.js');

    const session = {
      get: vi.fn(() => 'session-existing'),
      set: vi.fn(),
      clear: vi.fn(),
    };

    const onProcess = vi.fn();
    const onOutput = vi.fn(async () => {});

    const result = await mod.runDefaultRunner({
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      input: {
        prompt: 'hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        assistantName: 'Andy',
      },
      session,
      tasksSnapshot: [
        {
          id: 'task-1',
          groupFolder: 'test-group',
          prompt: 'do work',
          schedule_type: 'once',
          schedule_value: '2026-04-21T00:00:00.000Z',
          status: 'active',
          next_run: null,
        },
      ],
      groupsSnapshot: {
        availableGroups: [
          {
            jid: 'test@g.us',
            name: 'Test Group',
            lastActivity: '2026-04-21T00:00:00.000Z',
            isRegistered: true,
          },
        ],
        registeredJids: new Set(['test@g.us']),
      },
      onProcess,
      onOutput,
    });

    expect(runnerArtifacts.writeTasksSnapshot).toHaveBeenCalledWith(
      'test-group',
      false,
      expect.any(Array),
    );
    expect(runnerArtifacts.writeGroupsSnapshot).toHaveBeenCalledWith(
      'test-group',
      false,
      expect.any(Array),
      expect.any(Set),
    );
    expect(containerRunner.runContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        folder: 'test-group',
      }),
      expect.objectContaining({
        prompt: 'hello',
        sessionId: 'session-existing',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        assistantName: 'Andy',
      }),
      onProcess,
      expect.any(Function),
    );
    expect(session.set).toHaveBeenNthCalledWith(1, 'session-stream');
    expect(session.set).toHaveBeenNthCalledWith(2, 'session-final');
    expect(session.clear).not.toHaveBeenCalled();
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({ newSessionId: 'session-stream' }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        newSessionId: 'session-final',
      }),
    );
  });

  it('clears stale sessions inside the runner seam when the adapter reports a missing transcript', async () => {
    const containerRunner = await import('../claude/container-runner.js');
    vi.mocked(containerRunner.runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'ENOENT: missing session transcript .jsonl',
    });

    const mod = await import('./runner.js');

    const session = {
      get: vi.fn(() => 'session-existing'),
      set: vi.fn(),
      clear: vi.fn(),
    };

    const result = await mod.runDefaultRunner({
      group: {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      input: {
        prompt: 'hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
        assistantName: 'Andy',
      },
      session,
      onProcess: vi.fn(),
    });

    expect(session.clear).toHaveBeenCalledOnce();
    expect(result).toEqual(
      expect.objectContaining({
        status: 'error',
      }),
    );
  });

  it('dispatches to the codex runner when DEFAULT_RUNNER=codex', async () => {
    process.env.DEFAULT_RUNNER = 'codex';

    const codexRunner = await import('../codex/codex-runner.js');
    vi.mocked(codexRunner.runCodexAgent).mockResolvedValue({
      status: 'success',
      result: 'codex-final',
      newSessionId: 'codex-thread',
    });

    const mod = await import('./runner.js');

    const session = {
      get: vi.fn(() => 'codex-thread-old'),
      set: vi.fn(),
      clear: vi.fn(),
    };

    const result = await mod.runDefaultRunner({
      group: {
        name: 'Codex Group',
        folder: 'codex-group',
        trigger: '@Andy',
        added_at: new Date().toISOString(),
      },
      input: {
        prompt: 'hello codex',
        groupFolder: 'codex-group',
        chatJid: 'codex@g.us',
        isMain: false,
        assistantName: 'Andy',
      },
      session,
      onProcess: vi.fn(),
    });

    expect(codexRunner.runCodexAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'codex-group' }),
      expect.objectContaining({
        prompt: 'hello codex',
        sessionId: 'codex-thread-old',
      }),
      expect.any(Function),
      undefined,
    );
    expect(session.set).toHaveBeenCalledWith('codex-thread');
    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        newSessionId: 'codex-thread',
      }),
    );
  });
});
