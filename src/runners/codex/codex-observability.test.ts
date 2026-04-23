import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import { createCodexObservability } from './codex-observability.js';

describe('codex observability', () => {
  it('records raw notifications, reducer transitions, and unknown events', () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'codex-observability-'),
    );

    try {
      const diagnostics: unknown[] = [];
      const logs: string[] = [];
      const observability = createCodexObservability({
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        traceRootDir: rootDir,
        traceEnabled: true,
        writeDiagnostic: (event) => diagnostics.push(event),
        log: (message) => logs.push(message),
      });

      observability.observeRawStdoutLine(
        JSON.stringify({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            delta: '진행중',
          },
        }),
      );
      observability.applyParsedNotification({
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread-1',
          turnId: 'turn-1',
          delta: '진행중',
        },
      });
      observability.observeRawStdoutLine(
        JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'turn-1', status: 'completed', error: null },
          },
        }),
      );
      observability.applyParsedNotification({
        method: 'turn/completed',
        params: {
          threadId: 'thread-1',
          turn: { id: 'turn-1', status: 'completed', error: null },
        },
      });
      observability.observeRawStdoutLine(
        JSON.stringify({
          method: 'item/unknown',
          params: { foo: 'bar' },
        }),
      );
      observability.onParseFailure('not-json', new Error('bad json'));

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'codex.run.progress',
            turnId: 'turn-1',
          }),
          expect.objectContaining({ name: 'codex.run.completed' }),
          expect.objectContaining({ name: 'codex.run.parse_failure' }),
        ]),
      );
      const tracePath = observability.getTranscriptPath();
      const trace = fs.readFileSync(tracePath!, 'utf8');
      expect(trace).toContain('"method":"turn/completed"');
      expect(trace).toContain('"method":"item/unknown"');
      expect(logs.some((message) => message.includes('bad json'))).toBe(true);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
