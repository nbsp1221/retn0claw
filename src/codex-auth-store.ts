import fs from 'fs';

import { CODEX_OAUTH_TOKEN_STORE_PATH, DEFAULT_RUNNER } from './config.js';

export interface CodexOAuthTokens {
  idToken: string | null;
  accessToken: string;
  chatgptAccountId: string;
  chatgptPlanType: string | null;
}

function parsePlanType(idToken: string | undefined): string | null {
  if (!idToken) return null;

  try {
    const [, payload] = idToken.split('.');
    if (!payload) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return (
      parsed?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null
    );
  } catch {
    return null;
  }
}

export function getCodexOAuthTokenStorePath(): string {
  return CODEX_OAUTH_TOKEN_STORE_PATH;
}

export function readCodexOAuthTokens(): CodexOAuthTokens {
  const authPath = getCodexOAuthTokenStorePath();
  let parsed: {
    tokens?: {
      access_token?: string;
      account_id?: string;
      id_token?: string;
    };
  };

  try {
    parsed = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
  } catch (error) {
    throw new Error(
      `Failed to read CODEX_OAUTH_TOKEN_STORE_PATH at ${authPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const accessToken = parsed.tokens?.access_token;
  const chatgptAccountId = parsed.tokens?.account_id;
  if (!accessToken || !chatgptAccountId) {
    throw new Error(
      `Invalid CODEX_OAUTH_TOKEN_STORE_PATH at ${authPath}: expected tokens.access_token and tokens.account_id`,
    );
  }

  return {
    idToken: parsed.tokens?.id_token || null,
    accessToken,
    chatgptAccountId,
    chatgptPlanType: parsePlanType(parsed.tokens?.id_token),
  };
}

export function assertCodexRunnerReadiness(): void {
  if (DEFAULT_RUNNER.trim().toLowerCase() !== 'codex') return;
  readCodexOAuthTokens();
}
