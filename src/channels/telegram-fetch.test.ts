import { beforeEach, describe, expect, it, vi } from 'vitest';

const undiciFetchMock = vi.fn();
const AgentMock = vi.fn(function MockAgent(
  this: { options: unknown },
  options: unknown,
) {
  this.options = options;
});

vi.mock('undici', () => ({
  Agent: AgentMock,
  fetch: undiciFetchMock,
}));

describe('createTelegramFetch', () => {
  beforeEach(() => {
    undiciFetchMock.mockReset();
    AgentMock.mockClear();
    vi.resetModules();
  });

  it('retries with an IPv4-only dispatcher after a retryable network failure', async () => {
    const networkError = new TypeError('fetch failed');
    Object.assign(networkError, {
      cause: new AggregateError([
        Object.assign(new Error('connect ETIMEDOUT api.telegram.org:443'), {
          code: 'ETIMEDOUT',
        }),
      ]),
    });

    undiciFetchMock
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(new Response('ok'));

    const { createTelegramFetch } = await import('./telegram-fetch.js');
    const telegramFetch = createTelegramFetch();
    const response = await telegramFetch('https://api.telegram.org/botx/getMe');

    expect(response.ok).toBe(true);
    expect(undiciFetchMock).toHaveBeenCalledTimes(2);

    const firstDispatcher = undiciFetchMock.mock.calls[0]?.[1]?.dispatcher as {
      options?: { connect?: Record<string, unknown> };
    };
    const secondDispatcher = undiciFetchMock.mock.calls[1]?.[1]?.dispatcher as {
      options?: { connect?: Record<string, unknown> };
    };

    expect(firstDispatcher?.options?.connect).toMatchObject({
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 300,
    });
    expect(secondDispatcher?.options?.connect).toMatchObject({
      family: 4,
      autoSelectFamily: false,
    });
  });

  it('does not retry non-network failures', async () => {
    const authError = new Error('401 Unauthorized');
    undiciFetchMock.mockRejectedValueOnce(authError);

    const { createTelegramFetch } = await import('./telegram-fetch.js');
    const telegramFetch = createTelegramFetch();

    await expect(
      telegramFetch('https://api.telegram.org/botx/getMe'),
    ).rejects.toThrow('401 Unauthorized');
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);
  });
});
