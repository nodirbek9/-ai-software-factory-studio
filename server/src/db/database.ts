import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS: string[] = [
  `CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    spec TEXT NOT NULL,
    status TEXT NOT NULL,
    workspace_mode TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    integration_path TEXT,
    integration_branch TEXT,
    base_commit TEXT,
    test_command TEXT NOT NULL,
    plan_md TEXT,
    report_md TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    depends_on TEXT NOT NULL DEFAULT '[]',
    order_index INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 2,
    checkpoint TEXT NOT NULL DEFAULT 'none',
    branch TEXT,
    worktree_path TEXT,
    provider_id TEXT,
    model TEXT,
    result_summary TEXT,
    error TEXT,
    files_changed TEXT NOT NULL DEFAULT '[]',
    test_result TEXT,
    usage TEXT,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, key)
  );
  CREATE INDEX idx_tasks_project ON tasks(project_id, status);
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    task_id TEXT,
    role TEXT,
    type TEXT NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    data TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_project ON events(project_id, id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE TABLE agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    task_id TEXT,
    direction TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_messages ON agent_messages(project_id, role, id);
  CREATE TABLE agent_configs (
    role TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    allow_fallback INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE provider_configs (
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    budget_usd REAL
  );
  CREATE TABLE usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT,
    task_id TEXT,
    role TEXT,
    provider_id TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
  // v2: per-agent reasoning effort ('' = provider default)
  `ALTER TABLE agent_configs ADD COLUMN effort TEXT NOT NULL DEFAULT '';`,
  // v5: V2 agent sessions, session turns, saved workspace layouts, per-session usage (AGENT_WORKSPACE_SPEC.md §2)
  `CREATE TABLE agent_sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    role TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT NOT NULL DEFAULT '',
    allow_fallback INTEGER NOT NULL DEFAULT 0,
    mode TEXT NOT NULL CHECK (mode IN ('readonly','edit')),
    cwd_kind TEXT NOT NULL CHECK (cwd_kind IN ('integration','own-worktree')),
    branch TEXT,
    worktree_path TEXT,
    base_commit TEXT,
    continuity TEXT NOT NULL DEFAULT 'replay' CHECK (continuity IN ('native','replay')),
    provider_session_ref TEXT,
    task_id TEXT,
    status TEXT NOT NULL,
    last_error TEXT,
    last_activity_at TEXT,
    created_at TEXT NOT NULL,
    closed_at TEXT,
    UNIQUE(project_id, number)
  );
  CREATE INDEX idx_agent_sessions_project ON agent_sessions(project_id, status);
  CREATE TABLE session_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    author TEXT NOT NULL CHECK (author IN ('user','agent','system')),
    text TEXT NOT NULL,
    activity TEXT NOT NULL DEFAULT '[]',
    provider_id TEXT,
    model_reported TEXT,
    usage TEXT,
    files_changed TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT,
    error TEXT,
    UNIQUE(session_id, seq)
  );
  CREATE INDEX idx_session_turns_session ON session_turns(session_id, seq);
  CREATE TABLE workspace_layouts (
    project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    layout TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  ALTER TABLE usage_records ADD COLUMN session_id TEXT;`,
];

export type Db = DatabaseSync;

export function openDatabase(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  if (version > 0 && version < MIGRATIONS.length) backupBeforeMigrating(db, file);
  while (version < MIGRATIONS.length) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    });
    version += 1;
  }
  return db;
}

/** A consistent copy of an existing database before its schema is upgraded (D-018); kept once per target version. */
function backupBeforeMigrating(db: Db, file: string): void {
  const target = path.join(path.dirname(file), 'backups', `studio-before-v${MIGRATIONS.length}.db`);
  if (fs.existsSync(target)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
