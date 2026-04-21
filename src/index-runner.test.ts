import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('./runner-artifacts.js', () => ({
  writeTasksSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
}));

import {
  _initTestDatabase,
  getAllSessions,
  setSession,
  storeChatMetadata,
} from './db.js';
import {
  _runAgentForTests,
  _setRegisteredGroups,
  _setSessionsForTests,
} from './index.js';
import { runContainerAgent } from './container-runner.js';

const testGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-04-21T00:00:00.000Z',
};

describe('interactive runner seam', () => {
  beforeEach(() => {
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
    expect(getAllSessions()['test-group']).toBe('session-final');
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
    expect(getAllSessions()['test-group']).toBeUndefined();
    expect(result).toBe('error');
  });
});
