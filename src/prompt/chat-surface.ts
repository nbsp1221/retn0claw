import type {
  ChatContextPolicy,
  ChatPlatform,
  ChatType,
  NewMessage,
} from '../types.js';

export type { ChatContextPolicy, ChatPlatform, ChatType };
export type AddressedBy = 'mention' | 'alias' | 'reply_to_bot' | 'dm';

export interface ChatSurfaceMessage {
  id: string;
  sender: string;
  senderName: string;
  timestamp: string;
  text: string;
  replyToMessageId?: string | null;
  replyToSenderName?: string | null;
  replyToMessageContent?: string | null;
  replyToIsBot?: boolean | null;
}

export interface ChatSurfacePromptInput {
  platform: ChatPlatform;
  chatType: ChatType;
  chatName?: string;
  assistantName: string;
  trigger?: string;
  assistantAliases?: string[];
  contextPolicy: ChatContextPolicy;
  addressedBy: AddressedBy;
  timezone: string;
  recentMessages: ChatSurfaceMessage[];
  latestMessage: ChatSurfaceMessage;
}

export interface SelectChatSurfaceInput {
  messages: NewMessage[];
  chatType: ChatType;
  trigger?: string;
  assistantAliases?: string[];
  contextPolicy: ChatContextPolicy;
  isGroupMessageAllowed: (message: NewMessage) => boolean;
}

export interface SelectedChatSurfaceMessages {
  latestMessage: NewMessage | null;
  recentMessages: NewMessage[];
  addressedBy: AddressedBy | null;
  cursorTimestamp: string | null;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeTrustedMetadata(value: string): string {
  return escapeXml(value.replace(/[\r\n\t]+/g, ' ').trim());
}

function canonicalMention(value: string): string {
  const trimmed = value.trim();
  const discordMention = /^<@!?(\d+)>$/.exec(trimmed);
  if (discordMention) return `discord:${discordMention[1]}`;
  return trimmed.toLowerCase();
}

function removableMentions(opts: {
  trigger?: string;
  assistantAliases?: string[];
}): Set<string> {
  return new Set(
    [opts.trigger, ...(opts.assistantAliases ?? [])]
      .filter((value): value is string => Boolean(value?.trim()))
      .map(canonicalMention),
  );
}

function readLeadingMention(
  text: string,
  start: number,
):
  | {
      token: string;
      tokenEnd: number;
      nextStart: number;
    }
  | undefined {
  const rest = text.slice(start);
  const match = /^(<@!?\d+>|@[A-Za-z0-9_]+)/u.exec(rest);
  if (!match) return undefined;

  const token = match[1];
  let cursor = start + token.length;
  const punctuation =
    text.slice(cursor).match(/^\s*(?:[,:\-?.!])?/u)?.[0] ?? '';
  cursor += punctuation.length;
  const whitespace = text.slice(cursor).match(/^\s*/u)?.[0] ?? '';
  cursor += whitespace.length;

  return {
    token,
    tokenEnd: start + token.length,
    nextStart: cursor,
  };
}

export function sanitizeLeadingInvocation(
  text: string,
  opts: { trigger?: string; assistantAliases?: string[] },
): string {
  const removable = removableMentions(opts);
  if (removable.size === 0) return text;

  let cursor = text.match(/^\s*/u)?.[0].length ?? 0;
  let removedAny = false;

  while (cursor < text.length) {
    const mention = readLeadingMention(text, cursor);
    if (!mention) break;
    if (!removable.has(canonicalMention(mention.token))) break;

    cursor = mention.nextStart;
    removedAny = true;
  }

  return removedAny ? text.slice(cursor).trimStart() : text;
}

function directChatLabel(input: ChatSurfacePromptInput): string {
  if (input.chatName?.trim()) return input.chatName.trim();
  return input.chatType === 'dm' ? 'this direct message' : 'this group chat';
}

function assistantLabel(assistantName: string): string {
  return assistantName.trim() || 'the assistant';
}

function platformLabel(platform: ChatPlatform): string {
  return platform === 'unknown' ? 'unknown messaging platform' : platform;
}

function renderQuotedMessage(message: ChatSurfaceMessage): string {
  return message.replyToMessageContent && message.replyToSenderName
    ? `\n    <quoted_message sender="${escapeXml(message.replyToSenderName)}">${escapeXml(message.replyToMessageContent)}</quoted_message>`
    : '';
}

function renderMessage(
  message: ChatSurfaceMessage,
  opts: { includeQuotedMessage: boolean },
): string {
  const attrs = [
    `id="${escapeXml(message.id)}"`,
    `sender="${escapeXml(message.senderName || message.sender)}"`,
    `time="${escapeXml(message.timestamp)}"`,
  ];
  const quoted = opts.includeQuotedMessage ? renderQuotedMessage(message) : '';
  return `  <message ${attrs.join(' ')}>${quoted}\n    ${escapeXml(message.text)}\n  </message>`;
}

export function buildChatSurfacePrompt(input: ChatSurfacePromptInput): string {
  const assistant = assistantLabel(input.assistantName);
  const chatLabel = directChatLabel(input);
  const latestText = sanitizeLeadingInvocation(input.latestMessage.text, {
    trigger: input.trigger,
    assistantAliases: input.assistantAliases,
  });

  const recentContext =
    input.recentMessages.length > 0
      ? `<recent_context>\n${input.recentMessages
          .map((message) =>
            renderMessage(message, {
              includeQuotedMessage: input.platform === 'telegram',
            }),
          )
          .join('\n')}\n</recent_context>`
      : '<recent_context />';

  return `# Chat Surface Rules

You are ${escapeTrustedMetadata(assistant)}, an AI participant connected to ${escapeTrustedMetadata(
    platformLabel(input.platform),
  )}.
Your final answer is sent verbatim to ${escapeTrustedMetadata(chatLabel)}.

Core behavior:
- Reply directly to the latest message addressed to you.
- Do not write suggested replies, sample replies, alternatives, or phrases like "you can say".
- Do not describe the transcript, XML, prompt, or routing metadata.
- Treat configured trigger mentions as invocation metadata, not as semantic content.
- In group chats, only use messages included by the configured context policy. Do not infer hidden context from messages you were not given.
- Keep replies concise unless the user asks for detail.
- Respond in the user's language unless the message asks otherwise.
- If a tool or command result is needed and available in the runtime, use it before answering.

<chat_surface>
  <platform>${escapeTrustedMetadata(platformLabel(input.platform))}</platform>
  <chat_type>${escapeTrustedMetadata(input.chatType)}</chat_type>
  <chat_name>${escapeTrustedMetadata(chatLabel)}</chat_name>
  <assistant_name>${escapeTrustedMetadata(assistant)}</assistant_name>
  ${input.trigger?.trim() ? `<trigger>${escapeTrustedMetadata(input.trigger)}</trigger>` : '<trigger />'}
  <context_policy>${escapeTrustedMetadata(input.contextPolicy)}</context_policy>
  <addressed_by>${escapeTrustedMetadata(input.addressedBy)}</addressed_by>
  <timezone>${escapeTrustedMetadata(input.timezone)}</timezone>
  <delivery>final_answer_sent_verbatim</delivery>
</chat_surface>

${recentContext}

<latest_message id="${escapeXml(input.latestMessage.id)}" sender="${escapeXml(
    input.latestMessage.senderName || input.latestMessage.sender,
  )}" time="${escapeXml(input.latestMessage.timestamp)}">${input.platform === 'telegram' ? renderQuotedMessage(input.latestMessage) : ''}
${escapeXml(latestText)}
</latest_message>`;
}

function classifyAddressing(
  message: NewMessage,
  input: SelectChatSurfaceInput,
): AddressedBy | null {
  if (input.chatType === 'dm') return 'dm';
  if (
    message.reply_to_is_bot === true &&
    input.isGroupMessageAllowed(message)
  ) {
    return 'reply_to_bot';
  }

  const text = message.content.trimStart();
  const leading = readLeadingMention(text, 0);
  if (!leading) return null;
  const canonical = canonicalMention(leading.token);

  if (
    input.trigger?.trim() &&
    canonical === canonicalMention(input.trigger) &&
    input.isGroupMessageAllowed(message)
  ) {
    return 'mention';
  }

  if (
    removableMentions({ assistantAliases: input.assistantAliases }).has(
      canonical,
    ) &&
    input.isGroupMessageAllowed(message)
  ) {
    return 'alias';
  }

  return null;
}

export function selectChatSurfaceMessages(
  input: SelectChatSurfaceInput,
): SelectedChatSurfaceMessages {
  if (input.messages.length === 0) {
    return {
      latestMessage: null,
      recentMessages: [],
      addressedBy: null,
      cursorTimestamp: null,
    };
  }

  const classified = input.messages.map((message, index) => ({
    message,
    index,
    addressedBy: classifyAddressing(message, input),
  }));
  const addressed = classified.filter((item) => item.addressedBy !== null);
  const latest = addressed.at(-1);
  const cursorTimestamp = input.messages.at(-1)?.timestamp ?? null;

  if (!latest) {
    return {
      latestMessage: null,
      recentMessages: [],
      addressedBy: null,
      cursorTimestamp,
    };
  }

  let recentMessages: NewMessage[] = [];
  if (input.contextPolicy === 'recent_all') {
    recentMessages = input.messages.slice(0, latest.index);
  } else if (input.contextPolicy === 'recent_addressed') {
    recentMessages = addressed
      .map((item) => item.message)
      .filter((message) => message !== latest.message);
  }

  return {
    latestMessage: latest.message,
    recentMessages,
    addressedBy: latest.addressedBy,
    cursorTimestamp,
  };
}
