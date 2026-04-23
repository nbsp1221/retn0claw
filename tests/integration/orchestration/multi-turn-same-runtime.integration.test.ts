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
    result: 'done',
    ...overrides,
  };
}

describe('orchestration integration: multi-turn same runtime', () => {
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

  it('delivers one final per turn on the same live runtime', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    storeMessage({
      id: 'msg-1',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '첫 질문',
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
            eventKind: 'turn_started',
            phase: 'meta',
            result: null,
            newSessionId: 'thread-1',
            turnId: 'turn-1',
          }),
        );
        await emit?.(
          output({
            result: '첫 번째 답변',
            newSessionId: 'thread-1',
            turnId: 'turn-1',
          }),
        );
        await emit?.(
          output({
            eventKind: 'turn_started',
            phase: 'meta',
            result: null,
            newSessionId: 'thread-1',
            turnId: 'turn-2',
          }),
        );
        await emit?.(
          output({
            result: '두 번째 답변',
            newSessionId: 'thread-1',
            turnId: 'turn-2',
          }),
        );

        return {
          status: 'success',
          result: '두 번째 답변',
          newSessionId: 'thread-1',
        };
      },
    );

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      1,
      'test@g.us',
      '첫 번째 답변',
    );
    expect(channel.sendMessage).toHaveBeenNthCalledWith(
      2,
      'test@g.us',
      '두 번째 답변',
    );
    expect(channel.sendMessage).toHaveBeenCalledTimes(2);
  });
});
