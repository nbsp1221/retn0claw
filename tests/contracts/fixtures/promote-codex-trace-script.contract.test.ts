import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { promoteCodexTraceFixture } from '../../../scripts/promote-codex-trace-fixture.js';

describe('contract: codex trace promotion script', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes a JSONL trace into a deterministic sanitized fixture', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-promote-'));
    tempDirs.push(dir);

    const tracePath = path.join(dir, 'run-1.jsonl');
    const fixturePath = path.join(dir, 'run-1.fixture.json');
    fs.writeFileSync(
      tracePath,
      [
        JSON.stringify({
          groupFolder: 'telegram_retn0_dm',
          chatJid: 'tg:436146054',
          runnerKind: 'codex',
          runId: 'run-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          payload: {
            cwd: '/home/retn0/repositories/nbsp1221/retn0claw',
            accessToken: 'sk-live-abcdef',
          },
        }),
        JSON.stringify({
          groupFolder: 'telegram_retn0_dm',
          chatJid: 'tg:436146054',
          runnerKind: 'codex',
          runId: 'run-1',
          threadId: 'thread-1',
          turnId: 'turn-1',
          payload: {
            event: 'turn/completed',
          },
        }),
      ].join('\n'),
    );

    const resultPath = promoteCodexTraceFixture(tracePath, fixturePath);

    expect(resultPath).toBe(fixturePath);
    expect(JSON.parse(fs.readFileSync(fixturePath, 'utf8'))).toEqual([
      {
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        payload: {
          cwd: '[REDACTED_PATH]',
          accessToken: '[REDACTED_TOKEN]',
        },
      },
      {
        groupFolder: 'telegram_retn0_dm',
        chatJid: 'tg:436146054',
        runnerKind: 'codex',
        runId: 'run-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        payload: {
          event: 'turn/completed',
        },
      },
    ]);
  });
});
