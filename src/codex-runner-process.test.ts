import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('codex runner process helper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null when interrupted turn completion exceeds the timeout', async () => {
    const mod = await import('./codex-runner-process.js');

    const pending = new Promise<never>(() => {});
    const resultPromise = mod.waitForTurnCompletionWithTimeout(pending, 5000);

    await vi.advanceTimersByTimeAsync(5000);

    await expect(resultPromise).resolves.toBeNull();
  });
});
