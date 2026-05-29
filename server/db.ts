import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const dbPath = process.env.DB_PATH || './data/fileshare.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    username          TEXT UNIQUE NOT NULL,
    password_hash     TEXT NOT NULL,
    role              TEXT NOT NULL DEFAULT 'user',
    subscription_tier TEXT NOT NULL DEFAULT 'free',
    storage_used      INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id             TEXT PRIMARY KEY,
    owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    filename       TEXT NOT NULL,
    size           INTEGER NOT NULL DEFAULT 0,
    mime_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
    status         TEXT NOT NULL DEFAULT 'uploading',
    bytes_received INTEGER NOT NULL DEFAULT 0,
    -- AES-256-GCM file key wrapped with master key
    key_wrapped    TEXT,
    key_iv         TEXT,
    key_tag        TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at     TEXT
  );

  -- Per-chunk encryption metadata (chunk_index order = on-disk order)
  CREATE TABLE IF NOT EXISTS file_chunks (
    file_id          TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    chunk_index      INTEGER NOT NULL,
    cleartext_start  INTEGER NOT NULL,
    cleartext_size   INTEGER NOT NULL,
    encrypted_offset INTEGER NOT NULL,
    PRIMARY KEY (file_id, chunk_index)
  );

  CREATE TABLE IF NOT EXISTS file_shares (
    file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_write  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_id, user_id)
  );

  -- Groups
  CREATE TABLE IF NOT EXISTS groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS group_members (
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL DEFAULT 'member',
    joined_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, user_id)
  );

  -- Group invite links (join without knowing specific members)
  CREATE TABLE IF NOT EXISTS group_invites (
    id          TEXT PRIMARY KEY,
    group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    created_by  INTEGER NOT NULL REFERENCES users(id),
    -- optional password hash for invite
    pass_hash   TEXT,
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- File → Group permission
  CREATE TABLE IF NOT EXISTS file_group_shares (
    file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    can_write  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_id, group_id)
  );

  -- Tokenized share links (optionally password-protected with E2E key wrapping)
  CREATE TABLE IF NOT EXISTS share_links (
    id              TEXT PRIMARY KEY,
    file_id         TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    created_by      INTEGER NOT NULL REFERENCES users(id),
    can_write       INTEGER NOT NULL DEFAULT 0,
    max_downloads   INTEGER,
    downloads       INTEGER NOT NULL DEFAULT 0,
    expires_at      TEXT,
    -- If password-protected: file key wrapped with PBKDF2(password), not master key
    pass_key_wrapped TEXT,
    pass_key_iv     TEXT,
    pass_key_tag    TEXT,
    pass_salt       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS client_versions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    version    TEXT NOT NULL,
    platform   TEXT NOT NULL,
    filename   TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    is_latest  INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(version, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_files_owner         ON files(owner_id);
  CREATE INDEX IF NOT EXISTS idx_file_shares_user    ON file_shares(user_id);
  CREATE INDEX IF NOT EXISTS idx_file_chunks_file    ON file_chunks(file_id, chunk_index);
  CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX IF NOT EXISTS idx_versions_platform   ON client_versions(platform, is_latest);
  CREATE INDEX IF NOT EXISTS idx_group_members_user  ON group_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_file_group_shares   ON file_group_shares(file_id);
  CREATE INDEX IF NOT EXISTS idx_share_links_file    ON share_links(file_id);
`);

export type Row = Record<string, unknown>;
