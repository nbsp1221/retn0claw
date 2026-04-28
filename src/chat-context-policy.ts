import type { ChatContextPolicy } from './types.js';

export const CHAT_CONTEXT_POLICY_VALUES = [
  'current',
  'addressed_only',
  'recent_addressed',
  'recent_all',
] as const satisfies readonly ChatContextPolicy[];

const CHAT_CONTEXT_POLICY_SET = new Set<ChatContextPolicy>(
  CHAT_CONTEXT_POLICY_VALUES,
);

export function isChatContextPolicy(
  value: unknown,
): value is ChatContextPolicy {
  return (
    typeof value === 'string' &&
    CHAT_CONTEXT_POLICY_SET.has(value as ChatContextPolicy)
  );
}

export function parseChatContextPolicy(
  value: unknown,
): ChatContextPolicy | undefined {
  return isChatContextPolicy(value) ? value : undefined;
}
