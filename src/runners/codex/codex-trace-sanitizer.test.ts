import { describe, expect, it } from 'vitest';

import { sanitizeCodexTraceRecord } from './codex-trace-sanitizer.js';

describe('codex trace sanitizer', () => {
  it('redacts token-like and pii-like values', () => {
    const sanitized = sanitizeCodexTraceRecord({
      payload: {
        accessToken: 'sk-live-abcdef',
        idToken: 'eyJhbGciOiJIUzI1NiJ9.payload',
        email: 'user@example.com',
      },
    });

    expect(sanitized).toEqual({
      payload: {
        accessToken: '[REDACTED_TOKEN]',
        idToken: '[REDACTED_TOKEN]',
        email: '[REDACTED_EMAIL]',
      },
    });
  });

  it('normalizes absolute host paths', () => {
    expect(
      sanitizeCodexTraceRecord({
        payload: {
          cwd: '/home/retn0/repositories/nbsp1221/retn0claw',
          tmp: '/tmp/codex-traces/run-1.jsonl',
        },
      }),
    ).toEqual({
      payload: {
        cwd: '[REDACTED_PATH]',
        tmp: '[REDACTED_PATH]',
      },
    });
  });
});
