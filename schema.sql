-- ------------------------------------------------------------------
-- Rahat AI Workstation — D1 schema (complete, standalone)
--
-- The user said they will delete their current D1 database and create
-- a fresh one for this app. Apply this file to the NEW database:
--
--   npx wrangler d1 create rahat-ai-db
--   npx wrangler d1 execute rahat-ai-db --remote --file=./schema.sql
--
-- (or `npm run db:init`)
-- ------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- Single owner of this private workstation
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Server-side sessions (cookie holds a random token; only its SHA-256 is stored)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Chats
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New chat',
  agent_id   INTEGER,
  model      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC);

-- Chat messages (attachments live in the attachments table, files in B2)
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content         TEXT NOT NULL DEFAULT '',
  model           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);

-- Uploaded files metadata; the bytes live in a private Backblaze B2 bucket
CREATE TABLE IF NOT EXISTS attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id INTEGER,
  message_id      INTEGER,
  file_name       TEXT NOT NULL,
  b2_key          TEXT NOT NULL,
  mime_type       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('image','pdf','audio','video')),
  size            INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id);
CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);

-- Custom AI agents (name + system prompt + model). Seeded with "Rahat — CEO" on setup.
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  emoji         TEXT NOT NULL DEFAULT '🤖',
  description   TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model         TEXT,
  temperature   REAL NOT NULL DEFAULT 0.7,
  is_default    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Key/value app settings (default_model, default_image_model, ...)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);
