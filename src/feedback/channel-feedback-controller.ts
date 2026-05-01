import { logger } from '../logger.js';
import type {
  ChannelFeedbackCapabilities,
  FeedbackPulseResult,
  FeedbackTarget,
} from './types.js';

export type FeedbackStopReason =
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'superseded'
  | 'delivery_idle'
  | 'delivery_idle_grace'
  | 'run_returned'
  | 'safety_ttl'
  | 'shutdown'
  | 'unsupported'
  | 'repeated_failure';

export interface ChannelFeedbackControllerOptions {
  defaultTypingExpiresAfterMs?: number;
  defaultRefreshMs?: number;
  safetyTtlMs?: number;
  deliveryIdleGraceMs?: number;
  transientFailureLimit?: number;
}

export interface ChannelFeedbackController {
  start(input: {
    target: FeedbackTarget;
    feedback?: ChannelFeedbackCapabilities;
  }): void;
  touchActive(input: {
    chatJid: string;
    feedback?: ChannelFeedbackCapabilities;
    createFallbackTarget: () => FeedbackTarget;
  }): void;
  markRunComplete(target: FeedbackTarget): void;
  markDeliveryIdle(target: FeedbackTarget): void;
  stop(target: FeedbackTarget, reason: FeedbackStopReason): void;
  stopActive(chatJid: string, reason: FeedbackStopReason): void;
  shutdown(): void;
}

interface Session {
  key: string;
  target: FeedbackTarget;
  feedback: ChannelFeedbackCapabilities;
  active: boolean;
  refreshMs: number;
  pulseTimer: ReturnType<typeof setTimeout> | null;
  safetyTimer: ReturnType<typeof setTimeout> | null;
  deliveryIdleGraceTimer: ReturnType<typeof setTimeout> | null;
  transientFailures: number;
  pulseInFlight: boolean;
}

const DEFAULT_TYPING_EXPIRES_AFTER_MS = 10_000;
const DEFAULT_REFRESH_MS = 8_000;
const DEFAULT_SAFETY_TTL_MS = 600_000;
const DEFAULT_DELIVERY_IDLE_GRACE_MS = 30_000;
const DEFAULT_TRANSIENT_FAILURE_LIMIT = 3;

function generationKey(target: FeedbackTarget): string {
  return `${target.chatJid}:${target.runId}:${target.turnId}`;
}

function safeUnref(timer: ReturnType<typeof setTimeout> | null): void {
  timer?.unref?.();
}

function normalizeDelay(value: number | undefined): number | null {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return null;
  return value;
}

function resolveRefreshMs(
  feedback: ChannelFeedbackCapabilities,
  options: Required<ChannelFeedbackControllerOptions>,
): number {
  const expiresAfterMs =
    normalizeDelay(feedback.typingExpiresAfterMs) ??
    options.defaultTypingExpiresAfterMs;
  const requestedRefreshMs =
    normalizeDelay(feedback.recommendedRefreshMs) ?? options.defaultRefreshMs;

  if (requestedRefreshMs >= expiresAfterMs) {
    return Math.max(
      1,
      Math.min(options.defaultRefreshMs, expiresAfterMs - 1000),
    );
  }

  return requestedRefreshMs;
}

function normalizePulseResult(
  result: FeedbackPulseResult | void,
): FeedbackPulseResult {
  return result ?? { ok: true };
}

function normalizeError(error: unknown): FeedbackPulseResult {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const retryAfter =
      typeof record.retryAfterMs === 'number'
        ? record.retryAfterMs
        : typeof record.retry_after === 'number'
          ? record.retry_after * 1000
          : undefined;
    if (
      record.status === 429 ||
      record.statusCode === 429 ||
      record.error_code === 429 ||
      retryAfter !== undefined
    ) {
      return {
        ok: false,
        kind: 'rate_limited',
        retryAfterMs: retryAfter,
        scope: 'generation',
      };
    }
  }

  return { ok: false, kind: 'transient' };
}

export function createChannelFeedbackController(
  partialOptions: ChannelFeedbackControllerOptions = {},
): ChannelFeedbackController {
  const options: Required<ChannelFeedbackControllerOptions> = {
    defaultTypingExpiresAfterMs:
      partialOptions.defaultTypingExpiresAfterMs ??
      DEFAULT_TYPING_EXPIRES_AFTER_MS,
    defaultRefreshMs: partialOptions.defaultRefreshMs ?? DEFAULT_REFRESH_MS,
    safetyTtlMs: partialOptions.safetyTtlMs ?? DEFAULT_SAFETY_TTL_MS,
    deliveryIdleGraceMs:
      partialOptions.deliveryIdleGraceMs ?? DEFAULT_DELIVERY_IDLE_GRACE_MS,
    transientFailureLimit:
      partialOptions.transientFailureLimit ?? DEFAULT_TRANSIENT_FAILURE_LIMIT,
  };
  const sessions = new Map<string, Session>();
  const activeByChat = new Map<string, string>();

  function clearSessionTimers(session: Session): void {
    if (session.pulseTimer) clearTimeout(session.pulseTimer);
    if (session.safetyTimer) clearTimeout(session.safetyTimer);
    if (session.deliveryIdleGraceTimer) {
      clearTimeout(session.deliveryIdleGraceTimer);
    }
    session.pulseTimer = null;
    session.safetyTimer = null;
    session.deliveryIdleGraceTimer = null;
  }

  function stopSession(session: Session, reason: FeedbackStopReason): void {
    if (!session.active && !sessions.has(session.key)) return;
    session.active = false;
    clearSessionTimers(session);
    sessions.delete(session.key);
    if (activeByChat.get(session.target.chatJid) === session.key) {
      activeByChat.delete(session.target.chatJid);
    }
    logger.debug(
      {
        chatJid: session.target.chatJid,
        runId: session.target.runId,
        turnId: session.target.turnId,
        reason,
      },
      'Channel feedback stopped',
    );
  }

  function schedulePulse(session: Session, delayMs: number): void {
    if (!session.active) return;
    if (session.pulseTimer) clearTimeout(session.pulseTimer);
    session.pulseTimer = setTimeout(() => {
      session.pulseTimer = null;
      void pulseAndSchedule(session);
    }, delayMs);
    safeUnref(session.pulseTimer);
  }

  function scheduleSafetyTtl(session: Session): void {
    session.safetyTimer = setTimeout(() => {
      stopSession(session, 'safety_ttl');
    }, options.safetyTtlMs);
    safeUnref(session.safetyTimer);
  }

  function handlePulseResult(
    session: Session,
    result: FeedbackPulseResult,
  ): number | null {
    if (result.ok) {
      session.transientFailures = 0;
      return session.refreshMs;
    }

    if (result.kind === 'unsupported') {
      stopSession(session, 'unsupported');
      return null;
    }

    if (result.kind === 'rate_limited') {
      session.transientFailures = 0;
      return Math.max(
        result.retryAfterMs ?? session.refreshMs,
        session.refreshMs,
      );
    }

    session.transientFailures += 1;
    if (session.transientFailures >= options.transientFailureLimit) {
      stopSession(session, 'repeated_failure');
      return null;
    }

    return session.refreshMs;
  }

  async function pulseAndSchedule(session: Session): Promise<void> {
    if (!session.active || session.pulseInFlight) return;
    session.pulseInFlight = true;
    let nextDelay: number | null;
    try {
      logger.debug(
        {
          chatJid: session.target.chatJid,
          runId: session.target.runId,
          turnId: session.target.turnId,
        },
        'Channel feedback pulse started',
      );
      const result = normalizePulseResult(
        await session.feedback.pulseTyping(session.target),
      );
      nextDelay = handlePulseResult(session, result);
      logger.debug(
        {
          chatJid: session.target.chatJid,
          runId: session.target.runId,
          turnId: session.target.turnId,
          result,
          nextDelay,
        },
        'Channel feedback pulse completed',
      );
    } catch (error) {
      nextDelay = handlePulseResult(session, normalizeError(error));
      logger.debug(
        { err: error, chatJid: session.target.chatJid },
        'Channel feedback pulse failed',
      );
    } finally {
      session.pulseInFlight = false;
    }

    if (!session.active || nextDelay === null) return;
    schedulePulse(session, nextDelay);
  }

  function start(input: {
    target: FeedbackTarget;
    feedback?: ChannelFeedbackCapabilities;
  }): void {
    if (!input.feedback) return;

    const key = generationKey(input.target);
    const existing = sessions.get(key);
    if (existing) {
      activeByChat.set(input.target.chatJid, key);
      return;
    }

    const oldActive = activeByChat.get(input.target.chatJid);
    if (oldActive && oldActive !== key) {
      const oldSession = sessions.get(oldActive);
      if (oldSession) stopSession(oldSession, 'superseded');
    }

    const session: Session = {
      key,
      target: input.target,
      feedback: input.feedback,
      active: true,
      refreshMs: resolveRefreshMs(input.feedback, options),
      pulseTimer: null,
      safetyTimer: null,
      deliveryIdleGraceTimer: null,
      transientFailures: 0,
      pulseInFlight: false,
    };

    sessions.set(key, session);
    activeByChat.set(input.target.chatJid, key);
    scheduleSafetyTtl(session);
    void pulseAndSchedule(session);
  }

  function stop(target: FeedbackTarget, reason: FeedbackStopReason): void {
    const session = sessions.get(generationKey(target));
    if (session) stopSession(session, reason);
  }

  return {
    start,
    touchActive(input): void {
      const activeKey = activeByChat.get(input.chatJid);
      const session = activeKey ? sessions.get(activeKey) : undefined;
      if (session) {
        if (session.deliveryIdleGraceTimer) {
          clearTimeout(session.deliveryIdleGraceTimer);
          session.deliveryIdleGraceTimer = null;
        }
        return;
      }
      start({ target: input.createFallbackTarget(), feedback: input.feedback });
    },
    markRunComplete(target): void {
      const session = sessions.get(generationKey(target));
      if (!session || !session.active || session.deliveryIdleGraceTimer) return;
      session.deliveryIdleGraceTimer = setTimeout(() => {
        stopSession(session, 'delivery_idle_grace');
      }, options.deliveryIdleGraceMs);
      safeUnref(session.deliveryIdleGraceTimer);
    },
    markDeliveryIdle(target): void {
      const session = sessions.get(generationKey(target));
      if (!session || !session.deliveryIdleGraceTimer) return;
      stopSession(session, 'delivery_idle');
    },
    stop,
    stopActive(chatJid, reason): void {
      const activeKey = activeByChat.get(chatJid);
      if (!activeKey) return;
      const session = sessions.get(activeKey);
      if (session) stopSession(session, reason);
    },
    shutdown(): void {
      for (const session of [...sessions.values()]) {
        stopSession(session, 'shutdown');
      }
    },
  };
}
