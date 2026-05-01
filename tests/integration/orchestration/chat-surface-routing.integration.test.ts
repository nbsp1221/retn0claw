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

type Handler = (...args: any[]) => any;

const telegramBotRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('grammy', () => ({
  Bot: class MockBot {
    token: string;
    filterHandlers = new Map<string, Handler[]>();

    api = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendChatAction: vi.fn().mockResolvedValue(undefined),
      getFile: vi.fn().mockResolvedValue({ file_path: 'photos/file_0.jpg' }),
      getChat: vi.fn().mockResolvedValue({ is_forum: false }),
    };

    constructor(token: string) {
      this.token = token;
      telegramBotRef.current = this;
    }

    command(_name: string, _handler: Handler) {}

    on(filter: string, handler: Handler) {
      const existing = this.filterHandlers.get(filter) || [];
      existing.push(handler);
      this.filterHandlers.set(filter, existing);
    }

    catch(_handler: Handler) {}

    start(opts: { onStart: (botInfo: any) => void }) {
      opts.onStart({ username: 'retn0testerbot', id: 12345 });
    }

    stop() {}
  },
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
import { TelegramChannel } from '../../../src/channels/telegram.js';
import { runCodexAgent } from '../../../src/runners/codex/codex-runner.js';
import type { RegisteredGroup } from '../../../src/types.js';

const testGroup: RegisteredGroup = {
  name: '루나방',
  folder: 'luna-room',
  trigger: '@Andy',
  added_at: '2026-04-24T00:00:00.000Z',
};

function createChannel(jid = 'tg:-100') {
  return {
    name: 'telegram',
    ownsJid: (candidate: string) => candidate === jid,
    sendMessage: vi.fn(async () => {}),
    getAssistantAliases: vi.fn(() => ['@retn0testerbot']),
  };
}

function currentTelegramBot() {
  if (!telegramBotRef.current) {
    throw new Error('Telegram bot not initialized');
  }
  return telegramBotRef.current;
}

function createTelegramTextCtx(overrides: {
  chatId: number;
  chatType?: string;
  isForum?: boolean;
  text: string;
  messageId: number;
  date: number;
  message_thread_id?: number;
  reply_to_message?: any;
}) {
  return {
    chat: {
      id: overrides.chatId,
      type: overrides.chatType ?? 'supergroup',
      title: '루나방',
      ...(overrides.isForum === undefined
        ? {}
        : { is_forum: overrides.isForum }),
    },
    from: { id: 99001, first_name: 'retn0', username: 'retn0' },
    message: {
      text: overrides.text,
      date: overrides.date,
      message_id: overrides.messageId,
      entities: [],
      message_thread_id: overrides.message_thread_id,
      reply_to_message: overrides.reply_to_message,
    },
    me: { id: 12345, username: 'retn0testerbot' },
  };
}

async function triggerTelegramText(
  ctx: ReturnType<typeof createTelegramTextCtx>,
) {
  const handlers =
    currentTelegramBot().filterHandlers.get('message:text') || [];
  for (const handler of handlers) {
    await handler(ctx);
  }
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

  it('keeps ordinary trigger turns and reply-thread follow-ups in the same runner session', async () => {
    const chatJid = 'tg:-400';
    _setRegisteredGroups({ [chatJid]: testGroup });
    _setChannelsForTests([createChannel(chatJid) as any]);
    storeChatMetadata(
      chatJid,
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    storeMessage({
      id: 'turn-1',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: '@Andy A는 사과야',
      timestamp: '2026-04-24T00:00:01.000Z',
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    storeMessage({
      id: 'turn-2',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: 'A가 뭐였지?',
      timestamp: '2026-04-24T00:00:02.000Z',
      reply_to_message_id: 'bot-1',
      reply_to_message_content: 'A는 사과라고 했어요.',
      reply_to_sender_name: 'Andy',
      reply_to_is_bot: true,
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    const calls = vi.mocked(runCodexAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[1]).toMatchObject({
      groupFolder: 'luna-room',
      chatJid,
      sessionId: undefined,
    });
    expect(calls[1]?.[1]).toMatchObject({
      groupFolder: 'luna-room',
      chatJid,
      sessionId: 'codex-thread-1',
    });
    expect(calls[1]?.[1].chatJid).not.toContain('thread');
    expect(calls[1]?.[1].prompt).toContain(
      '<addressed_by>reply_to_bot</addressed_by>',
    );
  });

  it('routes a real Telegram adapter reply through DB into the existing group runner session', async () => {
    const chatId = -700;
    const chatJid = `tg:${chatId}`;
    _setRegisteredGroups({ [chatJid]: testGroup });

    const channel = new TelegramChannel('test-token', {
      onMessage: (_chatJid, message) => storeMessage(message),
      onChatMetadata: (
        metadataChatJid,
        timestamp,
        name,
        channelName,
        isGroup,
      ) =>
        storeChatMetadata(
          metadataChatJid,
          timestamp,
          name,
          channelName,
          isGroup,
        ),
      registeredGroups: () => ({ [chatJid]: testGroup }),
    });
    await channel.connect();
    _setChannelsForTests([channel]);

    await triggerTelegramText(
      createTelegramTextCtx({
        chatId,
        isForum: false,
        text: '@Andy A는 사과야',
        messageId: 1,
        date: Date.parse('2026-04-24T00:00:01.000Z') / 1000,
      }),
    );
    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    currentTelegramBot().api.getChat.mockResolvedValueOnce({
      id: chatId,
      type: 'supergroup',
      title: '루나방',
    });
    await triggerTelegramText(
      createTelegramTextCtx({
        chatId,
        text: 'A가 뭐였지?',
        messageId: 2,
        date: Date.parse('2026-04-24T00:00:02.000Z') / 1000,
        message_thread_id: 145837,
        reply_to_message: {
          message_id: 77,
          text: 'A는 사과라고 했어요.',
          from: { id: 12345, first_name: 'Andy' },
        },
      }),
    );
    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    const calls = vi.mocked(runCodexAgent).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[1]).toMatchObject({
      groupFolder: 'luna-room',
      chatJid,
      sessionId: 'codex-thread-1',
    });
    expect(calls[1]?.[1].chatJid).not.toContain('thread');
    expect(calls[1]?.[1].prompt).toContain(
      '<addressed_by>reply_to_bot</addressed_by>',
    );
    expect(calls[1]?.[1].prompt).toContain(
      '<quoted_message sender="Andy">A는 사과라고 했어요.</quoted_message>',
    );
  });

  it('does not invoke Codex for reply-to-human without a trigger', async () => {
    const chatJid = 'tg:-450';
    _setRegisteredGroups({ [chatJid]: testGroup });
    _setChannelsForTests([createChannel(chatJid) as any]);
    storeChatMetadata(
      chatJid,
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    storeMessage({
      id: 'reply-human',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: '사람에게만 답장',
      timestamp: '2026-04-24T00:00:01.000Z',
      reply_to_message_id: 'human-1',
      reply_to_message_content: '인간 메시지',
      reply_to_sender_name: 'Alice',
      reply_to_is_bot: false,
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    expect(runCodexAgent).not.toHaveBeenCalled();
  });

  it('routes media reply-to-bot placeholders as reply_to_bot', async () => {
    const chatJid = 'tg:-500';
    _setRegisteredGroups({ [chatJid]: testGroup });
    _setChannelsForTests([createChannel(chatJid) as any]);
    storeChatMetadata(
      chatJid,
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    storeMessage({
      id: 'media-reply',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: '[Photo] (/workspace/group/attachments/photo_1.jpg) 봐줘',
      timestamp: '2026-04-24T00:00:01.000Z',
      reply_to_message_id: 'bot-media',
      reply_to_message_content: 'Bot asked for a photo',
      reply_to_sender_name: 'Andy',
      reply_to_is_bot: true,
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('<addressed_by>reply_to_bot</addressed_by>');
    expect(prompt).toContain('[Photo]');
    expect(prompt).toContain('Bot asked for a photo');
  });

  it('does not leak unaddressed reply-to-human quoted content into a later prompt by default', async () => {
    const chatJid = 'tg:-600';
    _setRegisteredGroups({ [chatJid]: testGroup });
    _setChannelsForTests([createChannel(chatJid) as any]);
    storeChatMetadata(
      chatJid,
      '2026-04-24T00:00:00.000Z',
      '루나방',
      'telegram',
      true,
    );

    storeMessage({
      id: 'unaddressed-reply',
      chat_jid: chatJid,
      sender: 'alice',
      sender_name: 'Alice',
      content: '이건 사람에게 답장',
      timestamp: '2026-04-24T00:00:01.000Z',
      reply_to_message_id: 'human-quote',
      reply_to_message_content: '숨겨야 할 인용',
      reply_to_sender_name: 'Carol',
      reply_to_is_bot: false,
    });
    storeMessage({
      id: 'addressed-later',
      chat_jid: chatJid,
      sender: 'bob',
      sender_name: 'Bob',
      content: '@Andy 지금 질문',
      timestamp: '2026-04-24T00:00:02.000Z',
    });

    await expect(_processGroupMessagesForTests(chatJid)).resolves.toBe(true);

    const prompt = vi.mocked(runCodexAgent).mock.calls[0]?.[1].prompt;
    expect(prompt).toContain('지금 질문');
    expect(prompt).not.toContain('숨겨야 할 인용');
    expect(prompt).not.toContain('이건 사람에게 답장');
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
