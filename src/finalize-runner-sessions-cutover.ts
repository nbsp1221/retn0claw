import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from './config.js';

const CUTOVER_KEY = 'runner_sessions_cleanup_cutover';

function assertIpcQueuesAreQuiesced(dataDir: string): void {
  const ipcRoot = path.join(dataDir, 'ipc');
  if (!fs.existsSync(ipcRoot)) return;

  for (const groupFolder of fs.readdirSync(ipcRoot)) {
    const inputDir = path.join(ipcRoot, groupFolder, 'input');
    if (!fs.existsSync(inputDir)) continue;
    const entries = fs.readdirSync(inputDir);
    if (entries.length > 0) {
      throw new Error(
        `Cannot finalize runner session cutover: IPC input queue for ${groupFolder} is not quiesced.`,
      );
    }
  }
}

export function finalizeRunnerSessionsCutover(
  dbPath?: string,
  dataDir = DATA_DIR,
): void {
  const databasePath = dbPath || path.join(STORE_DIR, 'messages.db');
  const db = new Database(databasePath);
  const runtimeReady = db
    .prepare(
      "SELECT value FROM router_state WHERE key = 'runner_sessions_runtime_ready' LIMIT 1",
    )
    .get() as { value: string } | undefined;
  if (runtimeReady?.value !== 'phase2') {
    throw new Error(
      'Cannot finalize runner session cutover: current Phase 2 runtime has not marked the database ready.',
    );
  }

  const missingBackfill = db
    .prepare(
      `
      SELECT s.group_folder, s.session_id
      FROM sessions s
      LEFT JOIN runner_sessions rs
        ON rs.group_folder = s.group_folder
       AND rs.runner_kind = 'claude'
       AND rs.session_id = s.session_id
      WHERE rs.group_folder IS NULL
      `,
    )
    .all();

  if (missingBackfill.length > 0) {
    throw new Error(
      `Cannot finalize runner session cutover: legacy claude session backfill is incomplete for ${missingBackfill.length} row(s).`,
    );
  }

  assertIpcQueuesAreQuiesced(dataDir);

  const finalize = db.transaction(() => {
    db.prepare('DELETE FROM sessions').run();
    db.prepare(
      'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
    ).run(CUTOVER_KEY, 'complete');
  });
  finalize();
}
