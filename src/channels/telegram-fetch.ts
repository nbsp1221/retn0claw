import { Agent, fetch as undiciFetch } from 'undici';

const TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 300;
const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type FetchLike = typeof fetch;

function collectErrorCodes(error: unknown, out: Set<string>): void {
  if (!error || typeof error !== 'object') return;

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code) {
    out.add(code);
  }

  const cause = (error as { cause?: unknown }).cause;
  if (cause && cause !== error) {
    collectErrorCodes(cause, out);
  }

  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      collectErrorCodes(nested, out);
    }
  }
}

function isRetryableTelegramNetworkError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (message.includes('fetch failed')) {
    return true;
  }

  const codes = new Set<string>();
  collectErrorCodes(error, codes);
  for (const code of RETRYABLE_NETWORK_CODES) {
    if (codes.has(code)) {
      return true;
    }
  }
  return false;
}

export function createTelegramFetch(): FetchLike {
  const autoFamilyDispatcher = new Agent({
    connect: {
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout:
        TELEGRAM_AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
    } as any,
  });
  const ipv4Dispatcher = new Agent({
    connect: {
      family: 4,
      autoSelectFamily: false,
    } as any,
  });

  let stickyIpv4 = false;

  return async (input, init) => {
    const attempt = async (dispatcher: Agent) =>
      undiciFetch(input, {
        ...init,
        dispatcher:
          (init as RequestInit & { dispatcher?: unknown })?.dispatcher ||
          dispatcher,
      });

    if ((init as RequestInit & { dispatcher?: unknown })?.dispatcher) {
      return attempt(autoFamilyDispatcher);
    }

    if (stickyIpv4) {
      return attempt(ipv4Dispatcher);
    }

    try {
      return await attempt(autoFamilyDispatcher);
    } catch (error) {
      if (!isRetryableTelegramNetworkError(error)) {
        throw error;
      }
      stickyIpv4 = true;
      return attempt(ipv4Dispatcher);
    }
  };
}
