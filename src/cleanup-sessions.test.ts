import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

import { describe, expect, it } from 'vitest';

function touchOld(filePath: string, days: number): void {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, date, date);
}

function createSessionFile(baseDir: string, sessionId: string): string {
  const jsonlDir = path.join(
    baseDir,
    '.claude',
    'projects',
    '-workspace-group',
  );
  fs.mkdirSync(jsonlDir, { recursive: true });
  const file = path.join(jsonlDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  touchOld(file, 8);
  return file;
}

function createRepoFixture() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-sessions-'));
  fs.mkdirSync(path.join(repoDir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'store'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'data', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'groups', 'test-group', 'logs'), {
    recursive: true,
  });

  const sourceScript = path.join(
    process.cwd(),
    'scripts',
    'cleanup-sessions.sh',
  );
  const targetScript = path.join(repoDir, 'scripts', 'cleanup-sessions.sh');
  fs.copyFileSync(sourceScript, targetScript);
  fs.chmodSync(targetScript, 0o755);

  const db = new Database(path.join(repoDir, 'store', 'messages.db'));
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

  return { repoDir, db, scriptPath: targetScript };
}

describe('cleanup-sessions script', () => {
  it('protects active sessions from both stores before cutover', () => {
    const { repoDir, db, scriptPath } = createRepoFixture();

    db.prepare(
      'INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)',
    ).run('test-group', 'claude-active');
    db.prepare(
      'INSERT INTO runner_sessions (group_folder, runner_kind, session_id) VALUES (?, ?, ?)',
    ).run('test-group', 'codex', 'codex-active');

    const groupDir = path.join(repoDir, 'data', 'sessions', 'test-group');
    const claudeFile = createSessionFile(groupDir, 'claude-active');
    const codexFile = createSessionFile(groupDir, 'codex-active');
    const staleFile = createSessionFile(groupDir, 'stale-session');

    execFileSync('/bin/bash', [scriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        RETN0CLAW_SOURCE_ROOT: process.cwd(),
      },
    });

    expect(fs.existsSync(claudeFile)).toBe(true);
    expect(fs.existsSync(codexFile)).toBe(true);
    expect(fs.existsSync(staleFile)).toBe(false);
  });

  it('uses runner_sessions as the sole cleanup authority after cutover', () => {
    const { repoDir, db, scriptPath } = createRepoFixture();

    db.prepare(
      'INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)',
    ).run('test-group', 'legacy-claude');
    db.prepare(
      'INSERT INTO runner_sessions (group_folder, runner_kind, session_id) VALUES (?, ?, ?)',
    ).run('test-group', 'codex', 'codex-active');
    db.prepare('INSERT INTO router_state (key, value) VALUES (?, ?)').run(
      'runner_sessions_cleanup_cutover',
      'complete',
    );

    const groupDir = path.join(repoDir, 'data', 'sessions', 'test-group');
    const legacyFile = createSessionFile(groupDir, 'legacy-claude');
    const codexFile = createSessionFile(groupDir, 'codex-active');

    execFileSync('/bin/bash', [scriptPath], {
      cwd: repoDir,
      env: {
        ...process.env,
        RETN0CLAW_SOURCE_ROOT: process.cwd(),
      },
    });

    expect(fs.existsSync(codexFile)).toBe(true);
    expect(fs.existsSync(legacyFile)).toBe(false);
  });
});
