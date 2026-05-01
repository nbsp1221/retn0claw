export type FeedbackRateLimitScope = 'generation' | 'channel' | 'global';

export interface FeedbackTarget {
  chatJid: string;
  runId: string;
  turnId: string;
  threadId?: string | null;
  telegramMessageThreadId?: number | null;
  sourceMessageId?: string | null;
}

export type FeedbackPulseResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'transient' | 'rate_limited' | 'unsupported';
      retryAfterMs?: number;
      scope?: FeedbackRateLimitScope;
    };

export interface ChannelFeedbackCapabilities {
  pulseTyping(target: FeedbackTarget): Promise<FeedbackPulseResult | void>;
  typingExpiresAfterMs?: number;
  recommendedRefreshMs?: number;
}
