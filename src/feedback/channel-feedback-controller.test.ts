import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChannelFeedbackController } from './channel-feedback-controller.js';
import type {
  ChannelFeedbackCapabilities,
  FeedbackPulseResult,
  FeedbackTarget,
} from './types.js';

function target(overrides: Partial<FeedbackTarget> = {}): FeedbackTarget {
  return {
    chatJid: 'test@g.us',
    runId: 'run-1',
    turnId: 'turn-1',
    ...overrides,
  };
}

function capability(
  overrides: Partial<ChannelFeedbackCapabilities> = {},
): ChannelFeedbackCapabilities {
  return {
    typingExpiresAfterMs: 10_000,
    recommendedRefreshMs: 8_000,
    pulseTyping: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

describe('channel feedback controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an immediate first pulse and keeps refreshing at the recommended interval', async () => {
    vi.useFakeTimers();
    const feedback = capability();
    const controller = createChannelFeedbackController();

    controller.start({ target: target(), feedback });
    await vi.advanceTimersByTimeAsync(1);

    expect(feedback.pulseTyping).toHaveBeenCalledTimes(1);
    expect(feedback.pulseTyping).toHaveBeenCalledWith(target());

    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(2);

    controller.shutdown();
  });

  it('treats missing feedback capability as a no-op', async () => {
    vi.useFakeTimers();
    const controller = createChannelFeedbackController();

    expect(() => controller.start({ target: target() })).not.toThrow();
    await vi.advanceTimersByTimeAsync(600_000);

    expect(vi.getTimerCount()).toBe(0);
    controller.shutdown();
  });

  it('clamps invalid timing metadata to safe defaults', async () => {
    vi.useFakeTimers();
    const feedback = capability({
      typingExpiresAfterMs: 5_000,
      recommendedRefreshMs: 10_000,
    });
    const controller = createChannelFeedbackController();

    controller.start({ target: target(), feedback });
    await vi.advanceTimersByTimeAsync(1);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(2);

    controller.shutdown();
  });

  it('stops future pulses after delivery becomes idle', async () => {
    vi.useFakeTimers();
    const feedback = capability();
    const controller = createChannelFeedbackController();
    const feedbackTarget = target();

    controller.start({ target: feedbackTarget, feedback });
    await vi.advanceTimersByTimeAsync(1);

    controller.markRunComplete(feedbackTarget);
    controller.markDeliveryIdle(feedbackTarget);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdown();
  });

  it('keeps feedback alive when new input arrives during terminal delivery', async () => {
    vi.useFakeTimers();
    const feedback = capability();
    const controller = createChannelFeedbackController();
    const feedbackTarget = target();

    controller.start({ target: feedbackTarget, feedback });
    await vi.advanceTimersByTimeAsync(1);
    controller.markRunComplete(feedbackTarget);

    controller.touchActive({
      chatJid: feedbackTarget.chatJid,
      feedback,
      createFallbackTarget: () => target({ turnId: 'ipc-follow-up' }),
    });
    controller.markDeliveryIdle(feedbackTarget);

    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(2);
    expect(feedback.pulseTyping).toHaveBeenLastCalledWith(feedbackTarget);

    controller.shutdown();
  });

  it('does not let a late pulse resolution revive a stopped session', async () => {
    vi.useFakeTimers();
    let resolvePulse!: () => void;
    const feedback = capability({
      pulseTyping: vi.fn(
        (): Promise<FeedbackPulseResult> =>
          new Promise((resolve) => {
            resolvePulse = () => resolve({ ok: true as const });
          }),
      ),
    });
    const controller = createChannelFeedbackController();
    const feedbackTarget = target();

    controller.start({ target: feedbackTarget, feedback });
    await vi.advanceTimersByTimeAsync(1);
    controller.stop(feedbackTarget, 'completed');
    resolvePulse();
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdown();
  });

  it('prevents an older generation from pulsing after a newer generation starts', async () => {
    vi.useFakeTimers();
    const feedback = capability();
    const controller = createChannelFeedbackController();

    controller.start({ target: target({ turnId: 'turn-1' }), feedback });
    await vi.advanceTimersByTimeAsync(1);
    controller.start({ target: target({ turnId: 'turn-2' }), feedback });
    await vi.advanceTimersByTimeAsync(1);

    expect(feedback.pulseTyping).toHaveBeenCalledTimes(2);
    expect(feedback.pulseTyping).toHaveBeenLastCalledWith(
      target({ turnId: 'turn-2' }),
    );

    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(3);
    expect(feedback.pulseTyping).toHaveBeenLastCalledWith(
      target({ turnId: 'turn-2' }),
    );

    controller.shutdown();
  });

  it('does not throw feedback failures into the turn path and disables after repeated failures', async () => {
    vi.useFakeTimers();
    const feedback = capability({
      pulseTyping: vi.fn(async () => {
        throw new Error('platform failed');
      }),
    });
    const controller = createChannelFeedbackController({
      transientFailureLimit: 3,
    });

    controller.start({ target: target(), feedback });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(8_000);

    expect(feedback.pulseTyping).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdown();
  });

  it('uses retryAfterMs for rate limited pulses', async () => {
    vi.useFakeTimers();
    const feedback = capability({
      pulseTyping: vi
        .fn()
        .mockResolvedValueOnce({
          ok: false as const,
          kind: 'rate_limited' as const,
          retryAfterMs: 20_000,
        })
        .mockResolvedValue({ ok: true as const }),
    });
    const controller = createChannelFeedbackController();

    controller.start({ target: target(), feedback });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(2);

    controller.shutdown();
  });

  it('stops local keepalive at the safety ttl', async () => {
    vi.useFakeTimers();
    const feedback = capability();
    const controller = createChannelFeedbackController({
      safetyTtlMs: 600_000,
    });

    controller.start({ target: target(), feedback });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(600_000);

    const callsAtTtl = vi.mocked(feedback.pulseTyping).mock.calls.length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(feedback.pulseTyping).toHaveBeenCalledTimes(callsAtTtl);
    expect(vi.getTimerCount()).toBe(0);

    controller.shutdown();
  });
});
