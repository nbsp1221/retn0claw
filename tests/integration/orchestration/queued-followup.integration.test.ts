import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  getMessagesSince,
  storeChatMetadata,
  storeMessage,
} from '../../../src/db.js';
import {
  _processGroupMessagesForTests,
  _processMessageLoopGroupMessagesForTests,
  _resetFeedbackControllerForTests,
  _resetRouterStateForTests,
  _setChannelsForTests,
  _setFeedbackControllerForTests,
  _setRegisteredGroups,
  _setSessionsForTests,
} from '../../../src/index.js';
import { runContainerAgent } from '../../../src/runners/claude/container-runner.js';
import type { RunnerOutput } from '../../../src/runners/shared/runner.js';
import { createChannelFeedbackController } from '../../../src/feedback/channel-feedback-controller.js';
import type {
  FeedbackPulseResult,
  FeedbackTarget,
} from '../../../src/feedback/types.js';

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

describe('orchestration integration: queued follow-up', () => {
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

  afterEach(() => {
    _resetFeedbackControllerForTests();
    vi.useRealTimers();
  });

  it('separate inbound turns each produce one final without replaying the earlier turn', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);

    vi.mocked(runContainerAgent)
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        const emit = onOutput as
          | ((output: unknown) => Promise<void>)
          | undefined;
        await emit?.(
          output({ result: '첫 번째 답변', newSessionId: 'thread-1' }),
        );

        return {
          status: 'success',
          result: '첫 번째 답변',
          newSessionId: 'thread-1',
        };
      })
      .mockImplementationOnce(async (_group, _input, _onProcess, onOutput) => {
        const emit = onOutput as
          | ((output: unknown) => Promise<void>)
          | undefined;
        await emit?.(
          output({ result: '두 번째 답변', newSessionId: 'thread-1' }),
        );

        return {
          status: 'success',
          result: '두 번째 답변',
          newSessionId: 'thread-1',
        };
      });

    storeMessage({
      id: 'msg-1',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '첫 질문',
      timestamp: '2026-04-23T00:00:01.000Z',
      is_from_me: false,
    });

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );

    storeMessage({
      id: 'msg-2',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '둘째 질문',
      timestamp: '2026-04-23T00:00:02.000Z',
      is_from_me: false,
    });

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

  it('routes an older legacy trigger even when later chatter exceeds the prompt cap', async () => {
    const channel = createChannel();
    _setChannelsForTests([channel as any]);
    _setRegisteredGroups({
      'test@g.us': {
        ...testGroup,
        requiresTrigger: true,
      },
    });
    vi.mocked(runContainerAgent).mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'thread-1',
    });

    storeMessage({
      id: 'legacy-trigger',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: '@Andy 오래된 legacy 요청',
      timestamp: '2026-04-23T00:00:01.000Z',
      is_from_me: false,
    });
    for (let i = 1; i <= 12; i++) {
      storeMessage({
        id: `legacy-chatter-${i}`,
        chat_jid: 'test@g.us',
        sender: 'user-2',
        sender_name: 'Other',
        content: `legacy 잡담 ${i}`,
        timestamp: `2026-04-23T00:00:${String(i + 1).padStart(2, '0')}.000Z`,
        is_from_me: false,
      });
    }

    await expect(_processGroupMessagesForTests('test@g.us')).resolves.toBe(
      true,
    );

    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runContainerAgent).mock.calls[0]?.[1].prompt).toContain(
      '오래된 legacy 요청',
    );
  });

  it('routes accepted active-runtime follow-ups through the message-loop branch', async () => {
    vi.useFakeTimers();
    const pulseTyping = vi.fn(
      async (_target: FeedbackTarget): Promise<FeedbackPulseResult> => ({
        ok: true,
      }),
    );
    _setFeedbackControllerForTests(createChannelFeedbackController());
    const channel = {
      ...createChannel(),
      feedback: {
        typingExpiresAfterMs: 10_000,
        recommendedRefreshMs: 8_000,
        pulseTyping,
      },
    };
    _setChannelsForTests([channel as any]);
    storeMessage({
      id: 'msg-active-run',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: 'start long work',
      timestamp: '2026-04-23T00:00:03.000Z',
      is_from_me: false,
    });

    let finish!: () => void;
    vi.mocked(runContainerAgent).mockImplementation(
      async (_group, _input, _onProcess, onOutput) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        await onOutput?.(output({ result: 'done' }));
        return { status: 'success', result: 'done', newSessionId: 'thread-1' };
      },
    );
    const processing = _processGroupMessagesForTests('test@g.us');
    await vi.advanceTimersByTimeAsync(1);
    expect(pulseTyping).toHaveBeenCalledTimes(1);
    const activeTarget = pulseTyping.mock.calls[0]?.[0];
    expect(activeTarget.runId).not.toMatch(/^ipc-/);

    const followUpMessage = {
      id: 'msg-follow-up-1',
      chat_jid: 'test@g.us',
      sender: 'user-1',
      sender_name: 'retn0',
      content: 'follow up',
      timestamp: '2026-04-23T00:00:04.000Z',
      is_from_me: false,
    };
    storeMessage(followUpMessage);
    const groupMessages = getMessagesSince('test@g.us', '', 'Andy', 100);
    const sendActiveRuntimeMessage = vi.fn(() => true);

    _processMessageLoopGroupMessagesForTests({
      chatJid: 'test@g.us',
      groupMessages,
      sendActiveRuntimeMessage,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(sendActiveRuntimeMessage).toHaveBeenCalledWith(
      'test@g.us',
      expect.stringContaining('follow up'),
    );
    expect(pulseTyping).toHaveBeenCalledTimes(1);
    expect(pulseTyping.mock.calls[0]?.[0]).toMatchObject({
      chatJid: 'test@g.us',
    });
    expect(pulseTyping.mock.calls[0]?.[0].runId).toBe(activeTarget.runId);

    _processMessageLoopGroupMessagesForTests({
      chatJid: 'test@g.us',
      groupMessages,
      sendActiveRuntimeMessage,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(sendActiveRuntimeMessage).toHaveBeenCalledTimes(1);
    expect(pulseTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(pulseTyping).toHaveBeenCalledTimes(2);
    expect(pulseTyping.mock.calls[1]?.[0].runId).toBe(activeTarget.runId);

    finish();
    await processing;
  });
});
