import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DEFAULT_RUNNER = 'codex';
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
import { runCodexAgent } from '../../../src/runners/codex/codex-runner.js';
import type { RegisteredGroup } from '../../../src/types.js';

const testGroup: RegisteredGroup = {
  name: '루나방',
  folder: 'luna-room',
  trigger: '@Andy',
  added_at: '2026-04-24T00:00:00.000Z',
};

function createChannel() {
  return {
    name: 'telegram',
    ownsJid: (jid: string) => jid === 'tg:-100',
    sendMessage: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    getAssistantAliases: vi.fn(() => ['@retn0testerbot']),
  };
}

describe('orchestration integration: chat surface routing', () => {
  beforeEach(() => {
    _initTestDatabase();
    _setRegisteredGroups({ 'tg:-100': testGroup });
    _setSessionsForTests({});
    _setChannelsForTests([createChannel() as any]);
    vi.clearAllMocks();

    storeChatMetadata(
      'tg:-100',
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    vi.mocked(runCodexAgent).mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: 'codex-thread-1',
    });
  });

  it('passes Codex a chat-surface prompt and excludes unaddressed group neighbors by default', async () => {
    storeMessage({
      id: 'msg-1',
      chat_jid: 'tg:-100',
      sender: 'alice',
      sender_name: 'Alice',
      content: '사과는 맛있지',
      timestamp: '2026-04-24T00:00:01.000Z',
    });
    storeMessage({
      id: 'msg-2',
      chat_jid: 'tg:-100',
      sender: 'bob',
      sender_name: 'Bob',
      content: '@Andy @retn0testerbot 안녕? 넌 누구야?',
      timestamp: '2026-04-24T00:00:02.000Z',
    });
    storeMessage({
      id: 'msg-3',
      chat_jid: 'tg:-100',
      sender: 'carol',
      sender_name: 'Carol',
      content: '바나나도 먹을까?',
      timestamp: '2026-04-24T00:00:03.000Z',
    });

    await expect(_processGroupMessagesForTests('tg:-100')).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('Your final answer is sent verbatim');
    expect(prompt).toContain('Do not write suggested replies');
    expect(prompt.match(/<latest_message\b/g)).toHaveLength(1);
    expect(prompt).toContain('안녕? 넌 누구야?');
    expect(prompt).not.toContain('@Andy @retn0testerbot 안녕?');
    expect(prompt).not.toContain('사과는 맛있지');
    expect(prompt).not.toContain('바나나도 먹을까?');
  });

  it('allows a registered DM to invoke Codex without a trigger', async () => {
    const dmGroup: RegisteredGroup = {
      name: 'retn0',
      folder: 'telegram-dm-retn0',
      trigger: '@Andy',
      added_at: '2026-04-24T00:00:00.000Z',
    };
    _setRegisteredGroups({ 'tg:12345': dmGroup });
    _setChannelsForTests([
      {
        name: 'telegram',
        ownsJid: (jid: string) => jid === 'tg:12345',
        sendMessage: vi.fn(async () => {}),
        setTyping: vi.fn(async () => {}),
        getAssistantAliases: vi.fn(() => ['@retn0testerbot']),
      } as any,
    ]);

    storeChatMetadata(
      'tg:12345',
      '2026-04-24T00:00:00.000Z',
      'retn0',
      'telegram',
      false,
    );
    storeMessage({
      id: 'dm-1',
      chat_jid: 'tg:12345',
      sender: 'retn0',
      sender_name: 'retn0',
      content: '안녕? 넌 누구야?',
      timestamp: '2026-04-24T00:00:01.000Z',
    });

    await expect(_processGroupMessagesForTests('tg:12345')).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('<chat_type>dm</chat_type>');
    expect(prompt).toContain('<context_policy>current</context_policy>');
    expect(prompt).toContain('안녕? 넌 누구야?');
  });

  it('treats reply-to-bot as addressed without textual trigger', async () => {
    _setRegisteredGroups({ 'tg:-200': testGroup });
    _setChannelsForTests([
      {
        name: 'telegram',
        ownsJid: (jid: string) => jid === 'tg:-200',
        sendMessage: vi.fn(async () => {}),
        setTyping: vi.fn(async () => {}),
        getAssistantAliases: vi.fn(() => ['@retn0testerbot']),
      } as any,
    ]);
    storeChatMetadata(
      'tg:-200',
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );
    storeMessage({
      id: 'reply-1',
      chat_jid: 'tg:-200',
      sender: 'bob',
      sender_name: 'Bob',
      content: '이거 이어서 설명해줘',
      timestamp: '2026-04-24T00:00:01.000Z',
      reply_to_is_bot: true,
    });

    await expect(_processGroupMessagesForTests('tg:-200')).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('<addressed_by>reply_to_bot</addressed_by>');
    expect(prompt).toContain('이거 이어서 설명해줘');
  });

  it('applies a registered group recent_all policy to the Codex prompt', async () => {
    const chatJid = 'tg:-300';
    _setRegisteredGroups({
      [chatJid]: {
        ...testGroup,
        contextPolicy: 'recent_all',
      },
    });
    _setChannelsForTests([
      {
        name: 'telegram',
        ownsJid: (jid: string) => jid === chatJid,
        sendMessage: vi.fn(async () => {}),
        setTyping: vi.fn(async () => {}),
        getAssistantAliases: vi.fn(() => ['@retn0testerbot']),
      } as any,
    ]);
    storeChatMetadata(
      chatJid,
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    storeMessage({
      id: 'ctx-1',
      chat_jid: chatJid,
      sender: 'alice',
      sender_name: 'Alice',
      content: '이전 맥락',
      timestamp: '2026-04-24T00:00:01.000Z',
    });
    storeMessage({
      id: 'ctx-2',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: '@Andy 지금 질문',
      timestamp: '2026-04-24T00:00:02.000Z',
    });
    storeMessage({
      id: 'ctx-3',
      chat_jid: chatJid,
      sender: 'carol',
      sender_name: 'Carol',
      content: '이후 잡담',
      timestamp: '2026-04-24T00:00:03.000Z',
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('<context_policy>recent_all</context_policy>');
    expect(prompt).toContain('이전 맥락');
    expect(prompt).toContain('지금 질문');
    expect(prompt).not.toContain('이후 잡담');
  });
});
