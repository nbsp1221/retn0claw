import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('./runner.js', () => ({
  runDefaultRunner: vi.fn(),
  getSelectedRunnerKind: vi.fn(() => 'claude'),
}));

import { _initTestDatabase, createTask } from './db.js';
import { GroupQueue } from './group-queue.js';
import { getRunnerSession } from './runner-session-store.js';
import {
  _runAgentForTests,
  _setRegisteredGroups,
  _setSessionsForTests,
} from './index.js';
import { runDefaultRunner } from './runner.js';

describe('interactive runner path', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({});
    _setSessionsForTests({});
    vi.clearAllMocks();
  });

  it('routes interactive execution through the host runner seam and persists session updates', async () => {
    const registerProcessSpy = vi
      .spyOn(GroupQueue.prototype, 'registerProcess')
      .mockImplementation(() => {});

    createTask({
      id: 'task-1',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'task prompt',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    _setRegisteredGroups({
      'test@g.us': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-02-22T00:00:00.000Z',
      },
    });
    _setSessionsForTests({ 'test-group': 'session-existing' });

    vi.mocked(runDefaultRunner).mockImplementation(async (args) => {
      args.onProcess(new EventEmitter() as any, 'runtime-handle');
      await args.onOutput?.({
        status: 'success',
        result: 'streamed',
        newSessionId: 'session-stream',
      });
      args.session.set('session-final');
      return {
        status: 'success',
        result: 'final',
        newSessionId: 'session-final',
      };
    });

    const onOutput = vi.fn(async () => {});

    const result = await _runAgentForTests(
      {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2026-02-22T00:00:00.000Z',
      },
      'hello',
      'test@g.us',
      onOutput,
    );

    expect(runDefaultRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          prompt: 'hello',
          groupFolder: 'test-group',
          chatJid: 'test@g.us',
          isMain: false,
          assistantName: 'Andy',
        }),
        groupsSnapshot: expect.objectContaining({
          registeredJids: expect.any(Set),
        }),
      }),
    );
    expect(registerProcessSpy).toHaveBeenCalledWith(
      'test@g.us',
      expect.any(EventEmitter),
      'runtime-handle',
      'test-group',
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
});
