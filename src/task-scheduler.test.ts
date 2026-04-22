import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./runner.js', () => ({
  runDefaultRunner: vi.fn(),
  getSelectedRunnerKind: vi.fn(() =>
    process.env.DEFAULT_RUNNER === 'codex' ? 'codex' : 'claude',
  ),
}));

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import { getRunnerSession, setRunnerSession } from './runner-session-store.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';
import { runDefaultRunner } from './runner.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DEFAULT_RUNNER;
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });

  it('routes scheduled execution through the host runner seam', async () => {
    vi.mocked(runDefaultRunner).mockImplementation(async (args) => {
      await args.onOutput?.({
        status: 'success',
        result: 'streamed',
        newSessionId: 'session-123',
      });
      await args.onOutput?.({
        status: 'success',
        result: null,
        newSessionId: 'session-123',
      });
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      return {
        status: 'success',
        result: 'done',
        newSessionId: 'session-123',
      };
    });

    createTask({
      id: 'task-runner-seam',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    const notifyIdle = vi.fn();
    const closeStdin = vi.fn();
    const sendMessage = vi.fn(async () => {});

    startSchedulerLoop({
      registeredGroups: () => ({
        'test@g.us': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
      getSessions: () => ({ 'test-group': 'session-existing' }),
      queue: {
        enqueueTask,
        notifyIdle,
        closeStdin,
      } as any,
      onProcess: () => {},
      sendMessage,
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runDefaultRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sessionId: 'session-existing',
          prompt: 'run',
          groupFolder: 'test-group',
          chatJid: 'test@g.us',
        }),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith('test@g.us', 'streamed');
    expect(notifyIdle).toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);

    expect(closeStdin).toHaveBeenCalledWith('test@g.us');

    await vi.advanceTimersByTimeAsync(10_000);
  });

  it('uses codex runner sessions for group-context tasks when DEFAULT_RUNNER=codex', async () => {
    process.env.DEFAULT_RUNNER = 'codex';

    vi.mocked(runDefaultRunner).mockImplementation(async (args) => {
      args.session.set('codex-thread-final');
      await args.onOutput?.({
        status: 'success',
        result: 'codex-streamed',
        newSessionId: 'codex-thread-final',
      });
      return {
        status: 'success',
        result: 'codex-streamed',
        newSessionId: 'codex-thread-final',
      };
    });

    setRunnerSession('codex', 'test-group', 'codex-thread-existing');

    createTask({
      id: 'task-codex-session',
      group_folder: 'test-group',
      chat_jid: 'test@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'group',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({
        'test@g.us': {
          name: 'Test Group',
          folder: 'test-group',
          trigger: '@Andy',
          added_at: new Date().toISOString(),
        },
      }),
      getSessions: () => ({ 'test-group': 'codex-thread-existing' }),
      queue: {
        enqueueTask,
        notifyIdle: vi.fn(),
        closeStdin: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    expect(runDefaultRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          sessionId: 'codex-thread-existing',
        }),
      }),
    );
    expect(getRunnerSession('codex', 'test-group')).toBe(
      'codex-thread-final',
    );
  });
});
