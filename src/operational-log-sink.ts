import fs from 'fs';
import path from 'path';

export type OperationalLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface OperationalLogRecord {
  timestamp: string;
  level: OperationalLogLevel;
  message: string;
  data?: Record<string, unknown>;
}

export interface OperationalLogSinkOptions {
  rootDir?: string;
  now?: () => string;
  appendLine?: (filePath: string, line: string) => void;
  fallbackWrite?: (message: string) => void;
}

export function sanitizeOperationalLogRecord(
  record: OperationalLogRecord,
): OperationalLogRecord {
  if (!record.data) return record;
  const nextData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record.data)) {
    if (key === 'payload' || key === 'transcriptPayload') {
      nextData[key] = '[omitted]';
      continue;
    }
    nextData[key] = value;
  }
  return { ...record, data: nextData };
}

function defaultAppendLine(filePath: string, line: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, line);
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

export function createOperationalLogSink(
  options: OperationalLogSinkOptions = {},
) {
  const rootDir =
    options.rootDir || path.resolve(process.cwd(), 'data', 'logs');
  const now = options.now || (() => new Date().toISOString());
  const appendLine = options.appendLine || defaultAppendLine;
  const fallbackWrite =
    options.fallbackWrite ||
    ((message: string) => process.stderr.write(`${message}\n`));
  let failureBurstActive = false;
  let reentrant = false;

  return {
    getPathForTimestamp(iso: string): string {
      return path.join(rootDir, `retn0claw-${dayStamp(iso)}.log`);
    },
    write(record: OperationalLogRecord): void {
      const sanitized = sanitizeOperationalLogRecord(record);
      const filePath = this.getPathForTimestamp(sanitized.timestamp || now());
      try {
        appendLine(filePath, `${JSON.stringify(sanitized)}\n`);
        failureBurstActive = false;
      } catch (error) {
        if (reentrant || failureBurstActive) return;
        reentrant = true;
        failureBurstActive = true;
        try {
          fallbackWrite(
            `[operational-log-sink] ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          reentrant = false;
        }
      }
    },
  };
}
