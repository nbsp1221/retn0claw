import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../config.js';
import type { RunnerKind } from '../shared/runner.js';

export type CodexTranscriptSource =
  | 'app-server-stdout'
  | 'app-server-stderr'
  | 'host';

export interface CodexTranscriptRecord {
  timestamp: string;
  source: CodexTranscriptSource;
  groupFolder: string;
  chatJid: string | null;
  runnerKind: RunnerKind | null;
  runId: string;
  threadId: string | null;
  turnId: string | null;
  payload: unknown;
}

export interface CodexTranscriptSinkOptions {
  enabled?: boolean;
  rootDir?: string;
  groupFolder: string;
  chatJid: string | null;
  runnerKind: RunnerKind | null;
  runId: string;
  now?: () => string;
  warn?: (message: string) => void;
}

export function isCodexTraceEnabled(): boolean {
  return process.env.LOG_LEVEL === 'debug' || process.env.CODEX_TRACE === '1';
}

export function createCodexTranscriptSink(options: CodexTranscriptSinkOptions) {
  const enabled = options.enabled ?? isCodexTraceEnabled();
  const rootDir = options.rootDir || path.join(DATA_DIR, 'codex-traces');
  const tracePath = path.join(
    rootDir,
    options.groupFolder,
    `${options.runId}.jsonl`,
  );
  const now = options.now || (() => new Date().toISOString());
  const warn = options.warn || (() => {});

  return {
    isEnabled() {
      return enabled;
    },
    getPath() {
      return tracePath;
    },
    record(
      source: CodexTranscriptSource,
      payload: unknown,
      ids: { threadId: string | null; turnId: string | null },
    ): void {
      if (!enabled) return;
      try {
        fs.mkdirSync(path.dirname(tracePath), { recursive: true });
        const record: CodexTranscriptRecord = {
          timestamp: now(),
          source,
          groupFolder: options.groupFolder,
          chatJid: options.chatJid,
          runnerKind: options.runnerKind,
          runId: options.runId,
          threadId: ids.threadId,
          turnId: ids.turnId,
          payload,
        };
        fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`);
      } catch (error) {
        warn(
          `Failed to write Codex transcript: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
  };
}
