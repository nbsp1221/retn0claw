import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

function createDbFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cutover-'));
  const dbPath = path.join(dir, 'messages.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE runner_sessions (
      group_folder TEXT NOT NULL,
      runner_kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (group_folder, runner_kind)
    );
    CREATE TABLE router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return { db, dbPath };
}

describe('finalize runner sessions cutover', () => {
  it('refuses cutover when legacy claude sessions are not fully backfilled', async () => {
    const { db, dbPath } = createDbFixture();
    db.prepare('INSERT INTO router_state (key, value) VALUES (?, ?)').run(
      'runner_sessions_runtime_ready',
      'phase2',
    );
    db.prepare(
      'INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)',
    ).run('group-a', 'session-a');

    const mod = await import('./finalize-runner-sessions-cutover.js');

    expect(() => mod.finalizeRunnerSessionsCutover(dbPath)).toThrow(
      /backfill/i,
    );

    const marker = db
      .prepare(
        "SELECT value FROM router_state WHERE key = 'runner_sessions_cleanup_cutover'",
      )
      .get() as { value: string } | undefined;
    expect(marker).toBeUndefined();
  });

  it('writes the cutover marker after backfill is complete', async () => {
    const { db, dbPath } = createDbFixture();
    db.prepare('INSERT INTO router_state (key, value) VALUES (?, ?)').run(
      'runner_sessions_runtime_ready',
      'phase2',
    );
    db.prepare(
      'INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)',
    ).run('group-a', 'session-a');
    db.prepare(
      'INSERT INTO runner_sessions (group_folder, runner_kind, session_id) VALUES (?, ?, ?)',
    ).run('group-a', 'claude', 'session-a');

    const mod = await import('./finalize-runner-sessions-cutover.js');

    mod.finalizeRunnerSessionsCutover(dbPath);

    const marker = db
      .prepare(
        "SELECT value FROM router_state WHERE key = 'runner_sessions_cleanup_cutover'",
      )
      .get() as { value: string } | undefined;
    expect(marker?.value).toBe('complete');
    const legacyCount = db
      .prepare('SELECT COUNT(*) as count FROM sessions')
      .get() as { count: number };
    expect(legacyCount.count).toBe(0);
  });

  it('refuses cutover while IPC input queues are non-empty', async () => {
    const { db, dbPath } = createDbFixture();
    db.prepare('INSERT INTO router_state (key, value) VALUES (?, ?)').run(
      'runner_sessions_runtime_ready',
      'phase2',
    );
    db.prepare(
      'INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)',
    ).run('group-a', 'session-a');
    db.prepare(
      'INSERT INTO runner_sessions (group_folder, runner_kind, session_id) VALUES (?, ?, ?)',
    ).run('group-a', 'claude', 'session-a');

    const tempDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'runner-cutover-ipc-'),
    );
    const inputDir = path.join(tempDataDir, 'ipc', 'group-a', 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'pending.json'), '{"type":"message"}');

    const mod = await import('./finalize-runner-sessions-cutover.js');

    expect(() =>
      mod.finalizeRunnerSessionsCutover(dbPath, tempDataDir),
    ).toThrow(/quiesced|ipc/i);
  });
});
