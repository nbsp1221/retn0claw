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
  _processGroupMessagesForTests,
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
    setTyping: vi.fn(async () => {}),
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

describe('orchestration integration: one turn delivery', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({ 'test@g.us': testGroup });
    _setSessionsForTests({});
    vi.clearAllMocks();

    storeChatMetadata(
      'test@g.us',
      '2026-04-23T00:00:00.000Z',
      'Test Group',
      'whatsapp',
      true,
    );
  });

  it('progress storm and meta outputs still yield one visible final', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    storeMessage({
      id: 'msg-1',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '안녕?',
      timestamp: '2026-04-23T00:00:01.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        const emit = onOutput as
          | ((output: unknown) => Promise<void>)
          | undefined;
        await emit?.(
          output({
            eventKind: 'meta',
            phase: 'meta',
            turnId: null,
            result: null,
            newSessionId: 'thread-1',
          }),
        );
        await emit?.(
          output({
            eventKind: 'progress',
            phase: 'progress',
            result: '대',
            newSessionId: 'thread-1',
          }),
        );
        await emit?.(
          output({
            eventKind: 'progress',
            phase: 'progress',
            result: '...',
            newSessionId: 'thread-1',
          }),
        );
        await emit?.(output({ result: '최종 답변', newSessionId: 'thread-1' }));

        return {
          status: 'success',
          result: '최종 답변',
          newSessionId: 'thread-1',
        };
      },
    );

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith('test@g.us', '최종 답변');
  });

  it('meta-only output remains invisible to the user', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    storeMessage({
      id: 'msg-2',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '세션만 갱신해',
      timestamp: '2026-04-23T00:00:02.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: null,
      newSessionId: 'thread-2',
    });

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );
    expect(channel.sendMessage).not.toHaveBeenCalled();
  });

  it('duplicate final outputs still produce only one visible final', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    storeMessage({
      id: 'msg-3',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '중복 없이 보내',
      timestamp: '2026-04-23T00:00:03.000Z',
      is_from_me: false,
    });

    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        const emit = onOutput as
          | ((output: unknown) => Promise<void>)
          | undefined;
        await emit?.(
          output({
            result: '하나만',
            newSessionId: 'thread-3',
            threadId: 'thread-3',
          }),
        );
        await emit?.(
          output({
            result: '하나만',
            newSessionId: 'thread-3',
            threadId: 'thread-3',
          }),
        );

        return {
          status: 'success',
          result: '하나만',
          newSessionId: 'thread-3',
        };
      },
    );

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );
    expect(channel.sendMessage).toHaveBeenCalledTimes(1);
    expect(channel.sendMessage).toHaveBeenCalledWith('test@g.us', '하나만');
  });
});
