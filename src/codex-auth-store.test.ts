import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function writeAuthFile(data: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-store-'));
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function makeJwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    .toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

describe('codex auth store', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it('reads host-managed OAuth tokens from the configured token sink', async () => {
    const authPath = writeAuthFile({
      tokens: {
        access_token: 'access-token',
        account_id: 'account-123',
        id_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'plus',
          },
        }),
      },
    });
    process.env.CODEX_OAUTH_TOKEN_STORE_PATH = authPath;

    const mod = await import('./codex-auth-store.js');

    expect(mod.readCodexOAuthTokens()).toEqual({
      idToken: expect.any(String),
      accessToken: 'access-token',
      chatgptAccountId: 'account-123',
      chatgptPlanType: 'plus',
    });
  });

  it('throws when the configured token sink is missing required OAuth fields', async () => {
    const authPath = writeAuthFile({
      tokens: {
        access_token: 'access-token',
      },
    });
    process.env.CODEX_OAUTH_TOKEN_STORE_PATH = authPath;

    const mod = await import('./codex-auth-store.js');

    expect(() => mod.readCodexOAuthTokens()).toThrow(
      /CODEX_OAUTH_TOKEN_STORE_PATH/i,
    );
  });

  it('fails fast only when codex is the selected default runner', async () => {
    process.env.CODEX_OAUTH_TOKEN_STORE_PATH = path.join(
      os.tmpdir(),
      'missing-codex-auth.json',
    );

    process.env.DEFAULT_RUNNER = 'claude';
    let mod = await import('./codex-auth-store.js');
    expect(() => mod.assertCodexRunnerReadiness()).not.toThrow();

    process.env.DEFAULT_RUNNER = 'codex';
    vi.resetModules();
    mod = await import('./codex-auth-store.js');
    expect(() => mod.assertCodexRunnerReadiness()).toThrow(
      /CODEX_OAUTH_TOKEN_STORE_PATH/i,
    );
  });
});
