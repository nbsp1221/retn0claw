import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEFAULT_RUNNER = 'claude';
});

vi.mock('./runners/claude/container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('./runners/codex/codex-runner.js', () => ({
  runCodexAgent: vi.fn(),
}));

vi.mock('./runners/shared/runner-artifacts.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

import { _initTestDatabase, setSession, storeChatMetadata } from './db.js';
import {
  getRunnerSession,
  setRunnerSession,
} from './runners/shared/runner-session-store.js';
import {
  _runAgentForTests,
  _setRegisteredGroups,
  _setSessionsForTests,
} from './index.js';
import { runContainerAgent } from './runners/claude/container-runner.js';
import { runCodexAgent } from './runners/codex/codex-runner.js';

const testGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-04-21T00:00:00.000Z',
};

describe('interactive runner seam', () => {
  beforeEach(() => {
    process.env.DEFAULT_RUNNER = 'claude';
    _initTestDatabase();
    _setRegisteredGroups({ 'test@g.us': testGroup });
    _setSessionsForTests({});
    vi.clearAllMocks();

    storeChatMetadata(
      'test@g.us',
      '2026-04-21T00:00:00.000Z',
      'Test Group',
      'whatsapp',
      true,
    );
  });

  it('routes interactive execution through the runner seam and persists session updates', async () => {
    setSession('test-group', 'session-existing');
    _setSessionsForTests({ 'test-group': 'session-existing' });

    vi.mocked(runContainerAgent).mockImplementation(
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

    const onOutput = vi.fn(async () => {});

    const result = await _runAgentForTests(
      testGroup,
      'hello',
      'test@g.us',
      onOutput,
    );

    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'test-group' }),
      expect.objectContaining({
        prompt: 'hello',
        sessionId: 'session-existing',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      }),
      expect.any(Function),
      expect.any(Function),
    );
    expect(onOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        result: 'streamed',
        newSessionId: 'session-stream',
      }),
    );
    expect(getRunnerSession('claude', 'test-group')).toBe('session-final');
    expect(result).toBe('success');
  });

  it('clears stale sessions through the runner seam instead of caller-specific recovery logic', async () => {
    setSession('test-group', 'session-existing');
    _setSessionsForTests({ 'test-group': 'session-existing' });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'session not found',
    });

    const result = await _runAgentForTests(testGroup, 'hello', 'test@g.us');

    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'test-group' }),
      expect.objectContaining({
        sessionId: 'session-existing',
      }),
      expect.any(Function),
      undefined,
    );
    expect(getRunnerSession('claude', 'test-group')).toBeUndefined();
    expect(result).toBe('error');
  });

  it('loads and persists codex sessions when DEFAULT_RUNNER=codex', async () => {
    process.env.DEFAULT_RUNNER = 'codex';
    vi.resetModules();

    const db = await import('./db.js');
    const runnerSessionStore =
      await import('./runners/shared/runner-session-store.js');
    const indexMod = await import('./index.js');
    const codexRunner = await import('./runners/codex/codex-runner.js');

    db._initTestDatabase();
    indexMod._setRegisteredGroups({ 'test@g.us': testGroup });
    indexMod._setSessionsForTests({ 'test-group': 'codex-thread-existing' });
    db.storeChatMetadata(
      'test@g.us',
      '2026-04-21T00:00:00.000Z',
      'Test Group',
      'whatsapp',
      true,
    );
    runnerSessionStore.setRunnerSession(
      'codex',
      'test-group',
      'codex-thread-existing',
    );

    vi.mocked(codexRunner.runCodexAgent).mockResolvedValue({
      status: 'success',
      result: 'codex-final',
      newSessionId: 'codex-thread-final',
    });

    const result = await indexMod._runAgentForTests(
      testGroup,
      'hello',
      'test@g.us',
    );

    expect(codexRunner.runCodexAgent).toHaveBeenCalledWith(
      expect.objectContaining({ folder: 'test-group' }),
      expect.objectContaining({
        sessionId: 'codex-thread-existing',
      }),
      expect.any(Function),
      undefined,
    );
    expect(runnerSessionStore.getRunnerSession('codex', 'test-group')).toBe(
      'codex-thread-final',
    );
    expect(result).toBe('success');
  });
});
