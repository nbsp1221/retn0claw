import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it, vi } from 'vitest';

import {
  createOperationalLogSink,
  sanitizeOperationalLogRecord,
  type OperationalLogRecord,
} from './operational-log-sink.js';

function record(
  overrides: Partial<OperationalLogRecord> = {},
): OperationalLogRecord {
  return {
    timestamp: '2026-04-23T08:00:00.000Z',
    level: 'info',
    message: 'hello',
    data: { group: 'telegram_retn0_dm' },
    ...overrides,
  };
}

describe('operational log sink', () => {
  it('sanitizes transcript payloads before mirroring records', () => {
    expect(
      sanitizeOperationalLogRecord(
        record({
          data: {
            payload: { huge: true },
            transcriptPayload: { raw: 'should-go-away' },
          },
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        data: {
          payload: '[omitted]',
          transcriptPayload: '[omitted]',
        },
      }),
    );
  });

  it('writes rolling daily JSONL log files', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-log-'));

    try {
      const sink = createOperationalLogSink({
        rootDir,
        fallbackWrite: vi.fn(),
      });

      sink.write(record());

      const logPath = path.join(rootDir, 'retn0claw-2026-04-23.log');
      expect(fs.existsSync(logPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(logPath, 'utf8').trim())).toMatchObject(
        {
          message: 'hello',
        },
      );
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it('uses a direct fallback at most once per failure burst', () => {
    const fallbackWrite = vi.fn();
    const sink = createOperationalLogSink({
      rootDir: path.join(os.tmpdir(), 'should-not-exist'),
      appendLine: () => {
        throw new Error('disk-full');
      },
      fallbackWrite,
    });

    sink.write(record());
    sink.write(record({ message: 'again' }));

    expect(fallbackWrite).toHaveBeenCalledTimes(1);
    expect(String(fallbackWrite.mock.calls[0][0])).toContain('disk-full');
  });
});
