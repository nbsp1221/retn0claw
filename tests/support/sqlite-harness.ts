import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type RunnerKind = 'claude' | 'codex';

export interface RunnerSessionHarness {
  rootDir: string;
  dbPath: string;
  get(runnerKind: RunnerKind, groupFolder: string): string | undefined;
  set(runnerKind: RunnerKind, groupFolder: string, sessionId: string): void;
  clear(runnerKind: RunnerKind, groupFolder: string): void;
  close(): void;
}

export function createRunnerSessionHarness(
  prefix = 'retn0claw-contract-',
): RunnerSessionHarness {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(rootDir, 'messages.db');
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE runner_sessions (
      group_folder TEXT NOT NULL,
      runner_kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, runner_kind)
    );
  `);

  const getStmt = db.prepare(
    `SELECT session_id FROM runner_sessions WHERE runner_kind = ? AND group_folder = ?`,
  );
  const setStmt = db.prepare(`
    INSERT INTO runner_sessions (group_folder, runner_kind, session_id)
    VALUES (?, ?, ?)
    ON CONFLICT(group_folder, runner_kind) DO UPDATE SET
      session_id = excluded.session_id
  `);
  const clearStmt = db.prepare(
    `DELETE FROM runner_sessions WHERE runner_kind = ? AND group_folder = ?`,
  );

  return {
    rootDir,
    dbPath,
    get(runnerKind, groupFolder) {
      const row = getStmt.get(runnerKind, groupFolder) as
        | { session_id: string }
        | undefined;
      return row?.session_id;
    },
    set(runnerKind, groupFolder, sessionId) {
      setStmt.run(groupFolder, runnerKind, sessionId);
    },
    clear(runnerKind, groupFolder) {
      clearStmt.run(runnerKind, groupFolder);
    },
    close() {
      db.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
}
