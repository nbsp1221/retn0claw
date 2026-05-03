import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEFAULT_RUNNER = 'claude';
});

vi.mock('../../../src/runners/claude/container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../../../src/runners/codex/codex-runner.js', () => ({
  runCodexAgent: vi.fn(),
}));

import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
} from '../../../src/db.js';
import {
  getRunnerSession,
  setRunnerSession,
} from '../../../src/runners/shared/runner-session-store.js';
import {
  _processGroupMessagesForTests,
  _resetRouterStateForTests,
  _setChannelsForTests,
  _setRegisteredGroups,
  _setSessionsForTests,
} from '../../../src/index.js';
import { runContainerAgent } from '../../../src/runners/claude/container-runner.js';
import type { RunnerOutput } from '../../../src/runners/shared/runner.js';

const testGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-04-23T00:00:00.000Z',
  requiresTrigger: false,
};

function createChannel() {
  return {
    name: 'fake',
    ownsJid: (jid: string) => jid === 'test@g.us',
    sendMessage: vi.fn(async () => {}),
  };
}

function output(overrides: Partial<RunnerOutput>): RunnerOutput {
  return {
    status: 'success',
    eventKind: 'final',
    phase: 'final',
    threadId: 'thread-1',
    turnId: 'turn-1',
    result: 'final',
    ...overrides,
  };
}

describe('orchestration integration: runner session recovery', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({ 'test@g.us': testGroup });
    _setSessionsForTests({});
    _resetRouterStateForTests();
    vi.clearAllMocks();

    storeChatMetadata(
      'test@g.us',
      '2026-04-23T00:00:00.000Z',
      'Test Group',
      'whatsapp',
      true,
    );
  });

  it('does not roll back and resend after an error that happens after visible output', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    storeMessage({
      id: 'msg-1',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '질문',
      timestamp: '2026-04-23T00:00:01.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        const emit = onOutput as
          | ((output: unknown) => Promise<void>)
          | undefined;
        await emit?.(output({ result: '보낸 답변', newSessionId: 'thread-1' }));
        return {
          status: 'error',
          result: null,
          error: 'late failure',
        };
      },
    );

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );
    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );

    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith('test@g.us', '보낸 답변');
  });

  it('clears stale runner sessions after a session-not-found error', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    setRunnerSession('claude', 'test-group', 'stale-session');
    _setSessionsForTests({ 'test-group': 'stale-session' });

    storeMessage({
      id: 'msg-2',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '다시 시도',
      timestamp: '2026-04-23T00:00:02.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'error',
      result: null,
      error: 'session not found',
    });

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      false,
    );
    expect(getRunnerSession('claude', 'test-group')).toBeUndefined();
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });
});
