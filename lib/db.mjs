// The durable side of the plugin.
//
// Until 0.4.0 every form lived in process memory: a restart turned each pending
// form into `expired`, and the trade was "a one-time token never touches disk".
// Forms now outlive the process, so the token hash is what is written, never the
// token: a dump of this file does not open any link.
//
// One connection, opened by `apply()` and closed with the plugin scope. Node's
// own `node:sqlite` is synchronous, so every store method underneath is too —
// which is exactly what a form POST wants: a read, a decision and a write that
// no second request can interleave with.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Bumped when a table changes shape; a mismatch is a refusal, not a migration. */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One inbound request: the human types (or picks) a value and it lands in the
-- credential store or a file. The value itself is never a column of this table.
CREATE TABLE IF NOT EXISTS form (
  uuid        TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  ref         TEXT NOT NULL,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT,
  target      TEXT NOT NULL,
  allow_empty INTEGER NOT NULL DEFAULT 0,
  expect      TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  ttl_seconds INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  busy        INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  result      TEXT,
  session_id  TEXT,
  notify      INTEGER NOT NULL DEFAULT 1,
  notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS form_created ON form (created_at);
CREATE INDEX IF NOT EXISTS form_open ON form (status, expires_at);

-- One outbound secret: the model hands a value over, the human opens the link
-- and presses the reveal button exactly once. The value lives encrypted in
-- share_secret, its one-shot key in share_key; both rows are dropped the moment
-- the secret is revealed, cancelled or expired.
CREATE TABLE IF NOT EXISTS share (
  uuid        TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  description TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  source      TEXT NOT NULL DEFAULT 'file',
  file_name   TEXT,
  ttl_seconds INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  status      TEXT NOT NULL,
  views       INTEGER NOT NULL DEFAULT 0,
  revealed_at INTEGER,
  finished_at INTEGER,
  session_id  TEXT,
  notify      INTEGER NOT NULL DEFAULT 1,
  notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_created ON share (created_at);
CREATE INDEX IF NOT EXISTS share_open ON share (status, expires_at);

CREATE TABLE IF NOT EXISTS share_secret (
  uuid       TEXT PRIMARY KEY REFERENCES share (uuid) ON DELETE CASCADE,
  alg        TEXT NOT NULL,
  iv         TEXT NOT NULL,
  tag        TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS share_key (
  uuid TEXT PRIMARY KEY REFERENCES share (uuid) ON DELETE CASCADE,
  key  TEXT NOT NULL
);

-- Notes waiting for a session: placed through the schedule service, exactly the
-- way the graceful-restart plugin wakes a session after the host comes back.
CREATE TABLE IF NOT EXISTS note (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  session_id TEXT NOT NULL,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS note_session ON note (session_id);
`;

/**
 * Where the plugin keeps its database when the config names no file.
 * `$DSH_HOME/storages` is the directory the other plugins already use.
 */
export function defaultDatabasePath({ home = process.env.DSH_HOME } = {}) {
  const root = typeof home === 'string' && home.trim() !== '' ? home.trim() : join(homedir(), '.dsh');
  return join(root, 'storages', 'dsh-secret-form.sqlite');
}

/**
 * Open (and, on first use, create) the plugin database.
 * @param file - absolute path, or `:memory:` for tests.
 */
export function openDatabase(file) {
  if (typeof file !== 'string' || file.trim() === '') {
    throw new TypeError('dsh-secret-form: database must be a file path');
  }
  const path = file.trim();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // A copy of this file names every open form and holds every unclaimed
    // outbound secret, so it is readable by its owner only.
    try {
      chmodSync(dirname(path), 0o700);
    } catch {}
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 3000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  if (path !== ':memory:') {
    // WAL adds `-wal` and `-shm` beside the database; the prefix keeps them
    // under the same mode, and the database itself is set after the first write.
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        chmodSync(`${path}${suffix}`, 0o600);
      } catch {}
    }
  }
  const stored = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (stored === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (Number(stored.value) !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `dsh-secret-form: ${path} holds schema version ${stored.value}, this build needs ${SCHEMA_VERSION}; `
      + 'move the file aside to start a fresh one',
    );
  }
  return db;
}

/** Best-effort close: a store already closed by its scope must not throw twice. */
export function closeDatabase(db) {
  try {
    db?.close();
  } catch {}
}
