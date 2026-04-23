import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexTranscriptSink,
  isCodexTraceEnabled,
} from './codex-transcript-sink.js';

describe('codex transcript sink', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is disabled by default', () => {
    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('CODEX_TRACE', '');

    expect(isCodexTraceEnabled()).toBe(false);
  });

  it('activates in debug or trace mode', () => {
    vi.stubEnv('LOG_LEVEL', 'debug');
    expect(isCodexTraceEnabled()).toBe(true);

    vi.stubEnv('LOG_LEVEL', 'info');
    vi.stubEnv('CODEX_TRACE', '1');
    expect(isCodexTraceEnabled()).toBe(true);
  });

  it('writes host metadata and raw app-server lines as JSONL records', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trace-'));

    try {
      const warnings: string[] = [];
      const sink = createCodexTranscriptSink({
        enabled: true,
        rootDir,
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        warn: (message) => warnings.push(message),
      });

      sink.record(
        'host',
        { event: 'run.started' },
        { threadId: null, turnId: null },
      );
      sink.record(
        'app-server-stdout',
        { jsonrpc: '2.0', method: 'turn/completed' },
        { threadId: 'thread-1', turnId: 'turn-1' },
      );

      const tracePath = sink.getPath();
      expect(tracePath).toContain(
        path.join('telegram_retn0_dm', 'run-1.jsonl'),
      );

      const lines = fs.readFileSync(tracePath, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toMatchObject({
        source: 'host',
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        threadId: null,
        turnId: null,
      });
      expect(JSON.parse(lines[1])).toMatchObject({
        source: 'app-server-stdout',
        threadId: 'thread-1',
        turnId: 'turn-1',
      });
      expect(warnings).toEqual([]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
