import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

describe('database migrations', () => {
  it('backfills Telegram chat type from known JID patterns', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'retn0claw-db-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:12345', 'Telegram DM', '2024-01-01T00:00:00.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-10012345', 'Telegram Group', '2024-01-01T00:00:01.000Z');
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('room@g.us', 'WhatsApp Group', '2024-01-01T00:00:02.000Z');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getAllChats, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      const chats = getAllChats();
      expect(chats.find((chat) => chat.jid === 'tg:12345')).toMatchObject({
        channel: 'telegram',
        is_group: 0,
      });
      expect(chats.find((chat) => chat.jid === 'tg:-10012345')).toMatchObject({
        channel: 'telegram',
        is_group: 1,
      });
      expect(chats.find((chat) => chat.jid === 'room@g.us')).toMatchObject({
        channel: 'whatsapp',
        is_group: 1,
      });

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('backfills legacy sessions rows into runner_sessions for claude', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'retn0claw-db-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE sessions (
          group_folder TEXT PRIMARY KEY,
          session_id TEXT NOT NULL
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO sessions (group_folder, session_id) VALUES (?, ?)`,
        )
        .run('legacy-group', 'legacy-session');
      legacyDb.close();

      vi.resetModules();
      const { initDatabase, getRunnerSession, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      expect(getRunnerSession('claude', 'legacy-group')).toBe('legacy-session');

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('routes legacy sessions.json bootstrap into runner_sessions for claude', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'retn0claw-db-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'data'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'data', 'sessions.json'),
        JSON.stringify({ 'json-group': 'json-session' }),
      );

      vi.resetModules();
      const { initDatabase, getRunnerSession, _closeDatabase } =
        await import('./db.js');

      initDatabase();

      expect(getRunnerSession('claude', 'json-group')).toBe('json-session');

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });

  it('backfills durable message seq for legacy messages without seq column', async () => {
    const repoRoot = process.cwd();
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'retn0claw-db-test-'),
    );

    try {
      process.chdir(tempDir);
      fs.mkdirSync(path.join(tempDir, 'store'), { recursive: true });

      const dbPath = path.join(tempDir, 'store', 'messages.db');
      const legacyDb = new Database(dbPath);
      legacyDb.exec(`
        CREATE TABLE chats (
          jid TEXT PRIMARY KEY,
          name TEXT,
          last_message_time TEXT
        );
        CREATE TABLE messages (
          id TEXT,
          chat_jid TEXT,
          sender TEXT,
          sender_name TEXT,
          content TEXT,
          timestamp TEXT,
          is_from_me INTEGER,
          is_bot_message INTEGER DEFAULT 0,
          PRIMARY KEY (id, chat_jid)
        );
      `);
      legacyDb
        .prepare(
          `INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)`,
        )
        .run('tg:-100', 'Legacy Group', '2024-01-01T00:00:00.000Z');
      const insert = legacyDb.prepare(
        `
        INSERT INTO messages (
          id, chat_jid, sender, sender_name, content, timestamp,
          is_from_me, is_bot_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      );
      insert.run(
        'legacy-1',
        'tg:-100',
        'alice',
        'Alice',
        'first',
        '2024-01-01T00:00:01.000Z',
        0,
        0,
      );
      insert.run(
        'legacy-2',
        'tg:-100',
        'bob',
        'Bob',
        'second',
        '2024-01-01T00:00:01.000Z',
        0,
        0,
      );
      legacyDb.close();

      vi.resetModules();
      const {
        initDatabase,
        getMessagesAfterSeq,
        storeMessage,
        _closeDatabase,
      } = await import('./db.js');

      initDatabase();

      const migrated = getMessagesAfterSeq('tg:-100', 0, 'Andy', 10);
      expect(migrated.messages.map((message) => message.seq)).toEqual([1, 2]);
      expect(migrated.messages.map((message) => message.id)).toEqual([
        'legacy-1',
        'legacy-2',
      ]);

      storeMessage({
        id: 'new-1',
        chat_jid: 'tg:-100',
        sender: 'carol',
        sender_name: 'Carol',
        content: 'after migration',
        timestamp: '2024-01-01T00:00:02.000Z',
      });

      expect(
        getMessagesAfterSeq('tg:-100', 0, 'Andy', 10).messages.map(
          (message) => message.seq,
        ),
      ).toEqual([1, 2, 3]);

      _closeDatabase();
    } finally {
      process.chdir(repoRoot);
    }
  });
});
