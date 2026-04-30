export const TELEGRAM_FORUM_STATUS_LOOKUP_TIMEOUT_MS = 1500;

export type TelegramThreadDecision =
  | {
      deliverable: true;
      chatJid: string;
      scope: 'none' | 'dm';
      diagnosticReason?:
        | 'forum_status_missing_treated_as_non_forum'
        | 'forum_status_lookup_unavailable_treated_as_non_forum'
        | 'forum_status_lookup_timeout_treated_as_non_forum'
        | 'forum_status_lookup_rate_limited_treated_as_non_forum'
        | 'forum_status_lookup_failed_treated_as_non_forum';
      reason?: undefined;
    }
  | {
      deliverable: false;
      chatJid: string;
      scope: 'forum' | 'none';
      reason: 'unregistered_chat' | 'forum_topic_unsupported';
    };

export interface TelegramThreadInput {
  chat: {
    id: string | number;
    type: string;
    is_forum?: boolean;
  };
  messageThreadId?: number;
  isRegistered: boolean;
  getChat?: (chatId: string | number) => Promise<{ is_forum?: boolean }>;
  timeoutMs?: number;
}

const TELEGRAM_FORUM_SERVICE_FIELDS = [
  'forum_topic_created',
  'forum_topic_edited',
  'forum_topic_closed',
  'forum_topic_reopened',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
] as const;

function chatJid(chatId: string | number): string {
  return `tg:${chatId}`;
}

function isRateLimitError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return String(error).includes('429');
  }

  const value = error as {
    error_code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    description?: unknown;
  };

  return (
    value.error_code === 429 ||
    value.status === 429 ||
    value.statusCode === 429 ||
    String(value.message ?? '').includes('429') ||
    String(value.description ?? '').includes('429')
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<
  | { ok: true; value: T }
  | { ok: false; reason: 'timeout' }
  | { ok: false; reason: 'rejected'; error: unknown }
> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, reason: 'timeout' }),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: 'rejected', error });
      },
    );
  });
}

export async function resolveTelegramThreadDecision(
  input: TelegramThreadInput,
): Promise<TelegramThreadDecision> {
  const jid = chatJid(input.chat.id);
  const chatType = input.chat.type;

  if (chatType === 'private') {
    return { deliverable: true, chatJid: jid, scope: 'dm' };
  }

  if (chatType === 'group') {
    return { deliverable: true, chatJid: jid, scope: 'none' };
  }

  if (chatType !== 'supergroup') {
    return { deliverable: true, chatJid: jid, scope: 'none' };
  }

  if (input.chat.is_forum === true) {
    return {
      deliverable: false,
      chatJid: jid,
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    };
  }

  if (input.chat.is_forum === false) {
    return { deliverable: true, chatJid: jid, scope: 'none' };
  }

  if (!input.isRegistered) {
    return {
      deliverable: false,
      chatJid: jid,
      scope: 'none',
      reason: 'unregistered_chat',
    };
  }

  if (!input.getChat) {
    return {
      deliverable: true,
      chatJid: jid,
      scope: 'none',
      diagnosticReason: 'forum_status_lookup_unavailable_treated_as_non_forum',
    };
  }

  let getChatPromise: Promise<{ is_forum?: boolean }>;
  try {
    getChatPromise = Promise.resolve(input.getChat(input.chat.id));
  } catch (error) {
    return {
      deliverable: true,
      chatJid: jid,
      scope: 'none',
      diagnosticReason: isRateLimitError(error)
        ? 'forum_status_lookup_rate_limited_treated_as_non_forum'
        : 'forum_status_lookup_failed_treated_as_non_forum',
    };
  }

  const lookup = await withTimeout(
    getChatPromise,
    input.timeoutMs ?? TELEGRAM_FORUM_STATUS_LOOKUP_TIMEOUT_MS,
  );

  if (!lookup.ok) {
    if (lookup.reason === 'timeout') {
      return {
        deliverable: true,
        chatJid: jid,
        scope: 'none',
        diagnosticReason: 'forum_status_lookup_timeout_treated_as_non_forum',
      };
    }

    return {
      deliverable: true,
      chatJid: jid,
      scope: 'none',
      diagnosticReason: isRateLimitError(lookup.error)
        ? 'forum_status_lookup_rate_limited_treated_as_non_forum'
        : 'forum_status_lookup_failed_treated_as_non_forum',
    };
  }

  if (lookup.value.is_forum === true) {
    return {
      deliverable: false,
      chatJid: jid,
      scope: 'forum',
      reason: 'forum_topic_unsupported',
    };
  }

  if (lookup.value.is_forum === false) {
    return { deliverable: true, chatJid: jid, scope: 'none' };
  }

  return {
    deliverable: true,
    chatJid: jid,
    scope: 'none',
    diagnosticReason: 'forum_status_missing_treated_as_non_forum',
  };
}

export function isTelegramForumServiceMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  return TELEGRAM_FORUM_SERVICE_FIELDS.some((field) => field in message);
}

export function extractTelegramReplyMetadata(input: {
  replyTo: any;
  botId?: number;
}): {
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  reply_to_is_bot?: boolean;
} {
  const replyTo = input.replyTo;
  if (!replyTo) return {};

  const from = replyTo.from;
  const replyToIsBot =
    input.botId !== undefined &&
    from?.id !== undefined &&
    from.id === input.botId &&
    !isTelegramForumServiceMessage(replyTo);

  return {
    reply_to_message_id: replyTo.message_id?.toString(),
    reply_to_message_content: replyTo.text || replyTo.caption,
    reply_to_sender_name:
      from?.first_name || from?.username || from?.id?.toString() || 'Unknown',
    reply_to_is_bot: replyToIsBot,
  };
}
