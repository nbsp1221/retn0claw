import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';
import { isChatContextPolicy } from './chat-context-policy.js';
import type {
  ChatContextPolicy,
  ChatPlatform,
  ChatType,
  RegisteredGroup,
} from './types.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'CODEX_EFFORT',
  'CODEX_MODEL',
  'CODEX_OAUTH_TOKEN_STORE_PATH',
  'CHAT_CONTEXT_POLICY',
  'DEFAULT_RUNNER',
  'ONECLI_URL',
  'ONECLI_API_KEY',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'retn0claw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'retn0claw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'retn0claw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = process.env.ONECLI_URL || envConfig.ONECLI_URL;
export const ONECLI_API_KEY =
  process.env.ONECLI_API_KEY || envConfig.ONECLI_API_KEY;
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

export interface ChatContextPolicyConfig {
  defaults?: Partial<Record<ChatType, ChatContextPolicy>>;
  channels?: Partial<
    Record<ChatPlatform, Partial<Record<ChatType, ChatContextPolicy>>>
  >;
}

const CHAT_PLATFORMS = new Set<ChatPlatform>([
  'telegram',
  'discord',
  'unknown',
]);

function normalizePolicyMap(
  value: unknown,
): Partial<Record<ChatType, ChatContextPolicy>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const result: Partial<Record<ChatType, ChatContextPolicy>> = {};
  if (isChatContextPolicy(record.dm)) result.dm = record.dm;
  if (isChatContextPolicy(record.group)) result.group = record.group;
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseChatContextPolicyConfig(
  raw?: string,
): ChatContextPolicyConfig {
  if (!raw?.trim()) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== 'object') return {};
  const record = parsed as Record<string, unknown>;
  const defaults = normalizePolicyMap(record.defaults);
  const channels: ChatContextPolicyConfig['channels'] = {};

  if (record.channels && typeof record.channels === 'object') {
    for (const [platform, value] of Object.entries(
      record.channels as Record<string, unknown>,
    )) {
      if (!CHAT_PLATFORMS.has(platform as ChatPlatform)) continue;
      const normalized = normalizePolicyMap(value);
      if (normalized) channels[platform as ChatPlatform] = normalized;
    }
  }

  return {
    ...(defaults ? { defaults } : {}),
    ...(Object.keys(channels).length > 0 ? { channels } : {}),
  };
}

export function resolveChatContextPolicy(input: {
  chatType: ChatType;
  platform: ChatPlatform;
  registeredGroup?: Pick<RegisteredGroup, 'contextPolicy'>;
  config?: ChatContextPolicyConfig;
}): ChatContextPolicy {
  const builtInDefault = input.chatType === 'dm' ? 'current' : 'addressed_only';
  return (
    input.registeredGroup?.contextPolicy ??
    input.config?.channels?.[input.platform]?.[input.chatType] ??
    input.config?.defaults?.[input.chatType] ??
    builtInDefault
  );
}

export const CHAT_CONTEXT_POLICY_CONFIG = parseChatContextPolicyConfig(
  process.env.CHAT_CONTEXT_POLICY || envConfig.CHAT_CONTEXT_POLICY,
);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
export const DEFAULT_RUNNER =
  process.env.DEFAULT_RUNNER || envConfig.DEFAULT_RUNNER || 'claude';
export const CODEX_OAUTH_TOKEN_STORE_PATH =
  process.env.CODEX_OAUTH_TOKEN_STORE_PATH ||
  envConfig.CODEX_OAUTH_TOKEN_STORE_PATH ||
  path.join(HOME_DIR, '.codex', 'auth.json');
export const CODEX_MODEL = process.env.CODEX_MODEL || envConfig.CODEX_MODEL;
export const CODEX_EFFORT = process.env.CODEX_EFFORT || envConfig.CODEX_EFFORT;
