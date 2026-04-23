const TOKEN_PATTERN = /^(sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._-]+)$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const ABSOLUTE_PATH_PATTERN =
  /^(\/(?:home|Users|tmp|var|private)\/[^\s]+|[A-Za-z]:\\[^\s]+)$/;

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry)]),
    );
  }

  if (typeof value !== 'string') {
    return value;
  }

  if (TOKEN_PATTERN.test(value)) {
    return '[REDACTED_TOKEN]';
  }

  if (EMAIL_PATTERN.test(value)) {
    return '[REDACTED_EMAIL]';
  }

  if (ABSOLUTE_PATH_PATTERN.test(value)) {
    return '[REDACTED_PATH]';
  }

  return value;
}

export function sanitizeCodexTraceRecord<T>(record: T): T {
  return sanitizeValue(record) as T;
}
