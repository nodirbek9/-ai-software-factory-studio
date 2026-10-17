import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { STANDARD_WORKFLOW_ID } from '@asf/shared';
import { STANDARD_WORKFLOW_DESCRIPTION, STANDARD_WORKFLOW_GRAPH, STANDARD_WORKFLOW_NAME } from '../workflows/standardTemplate.ts';

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
  // v6 (spec name; index 3): workflows, runs, tasks rebuilt per run, usage per run (WORKFLOW_ENGINE_SPEC.md §2, PHASE_4 P4-1)
  `CREATE TABLE workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    graph TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    workflow_id TEXT,
    workflow_name TEXT NOT NULL DEFAULT '',
    workflow_version INTEGER,
    workflow_snapshot TEXT NOT NULL,
    status TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    base_commit TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_summary TEXT,
    UNIQUE(project_id, number)
  );
  CREATE INDEX idx_runs_project ON runs(project_id, number);
  INSERT INTO workflows (id, project_id, name, description, version, graph, builtin, archived, created_at, updated_at)
    VALUES (${sql(STANDARD_WORKFLOW_ID)}, NULL, ${sql(STANDARD_WORKFLOW_NAME)}, ${sql(STANDARD_WORKFLOW_DESCRIPTION)}, 1,
      ${sql(JSON.stringify(STANDARD_WORKFLOW_GRAPH))}, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  INSERT INTO runs (id, project_id, number, workflow_id, workflow_name, workflow_version, workflow_snapshot, status, "trigger",
      base_commit, started_at, finished_at)
    SELECT 'run-' || p.id, p.id, 1, ${sql(STANDARD_WORKFLOW_ID)}, ${sql(STANDARD_WORKFLOW_NAME)}, 1,
      ${sql(JSON.stringify(STANDARD_WORKFLOW_GRAPH))},
      CASE WHEN p.status = 'draft' THEN 'cancelled' ELSE p.status END, 'backfill', p.base_commit, p.created_at,
      CASE WHEN p.status IN ('completed', 'failed', 'cancelled', 'draft') THEN p.updated_at END
    FROM projects p WHERE p.status != 'draft' OR EXISTS (SELECT 1 FROM tasks t WHERE t.project_id = p.id);
  CREATE TABLE tasks_v3 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    node_id TEXT,
    options TEXT NOT NULL DEFAULT '{}',
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
    UNIQUE(run_id, key)
  );
  INSERT INTO tasks_v3 (id, project_id, run_id, node_id, options, key, title, description, role, kind, status, depends_on,
      order_index, attempt, max_attempts, checkpoint, branch, worktree_path, provider_id, model, result_summary, error,
      files_changed, test_result, usage, started_at, finished_at, updated_at)
    SELECT id, project_id, 'run-' || project_id, NULL, '{}', key, title, description, role, kind, status, depends_on,
      order_index, attempt, max_attempts, checkpoint, branch, worktree_path, provider_id, model, result_summary, error,
      files_changed, test_result, usage, started_at, finished_at, updated_at
    FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v3 RENAME TO tasks;
  CREATE INDEX idx_tasks_project ON tasks(project_id, status);
  CREATE INDEX idx_tasks_run ON tasks(run_id, status);
  ALTER TABLE usage_records ADD COLUMN run_id TEXT;
  UPDATE usage_records SET run_id = (SELECT t.run_id FROM tasks t WHERE t.id = usage_records.task_id) WHERE task_id IS NOT NULL;
  INSERT OR IGNORE INTO settings (key, value)
    SELECT 'fixRounds:run-' || substr(key, 11), value FROM settings
    WHERE substr(key, 1, 10) = 'fixRounds:' AND substr(key, 1, 14) != 'fixRounds:run-';`,
  // index 4: quality findings of security/review agents and npm audit (PHASE_6 P6-1); the per-run uniqueness of
  // (source, task key, fingerprint) is enforced by FindingRepository (run_id is NULL for some audits)
  `CREATE TABLE findings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
    task_id TEXT,
    source TEXT NOT NULL,
    severity TEXT NOT NULL,
    title TEXT NOT NULL,
    file TEXT,
    line INTEGER,
    description TEXT NOT NULL DEFAULT '',
    recommendation TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    note TEXT,
    fix_task_id TEXT,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_findings_project ON findings(project_id, run_id);
  CREATE INDEX idx_findings_run ON findings(run_id, task_id);`,
];

/** Tables whose foreign keys are verified after a migration (index → tables); a violation rolls the migration back. */
const FOREIGN_KEY_CHECKS: Record<number, string[]> = { 3: ['tasks', 'runs', 'workflows'], 4: ['findings'] };

export const SCHEMA_VERSION = MIGRATIONS.length;

export type Db = DatabaseSync;

/** Opens (and migrates) the database. `upToVersion` stops early — tests use it to build a database at an older schema. */
export function openDatabase(file: string, options: { upToVersion?: number } = {}): Db {
  const target = Math.min(options.upToVersion ?? MIGRATIONS.length, MIGRATIONS.length);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  if (version > 0 && version < target) backupBeforeMigrating(db, file, target);
  while (version < target) {
    const index = version;
    transaction(db, () => {
      db.exec(MIGRATIONS[index]);
      assertForeignKeys(db, FOREIGN_KEY_CHECKS[index] ?? []);
      db.prepare('UPDATE schema_version SET version = ?').run(index + 1);
    });
    version += 1;
  }
  return db;
}

/** SQL string literal (single quotes doubled) for values built into a migration from code. */
function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function assertForeignKeys(db: Db, tables: string[]): void {
  for (const table of tables) {
    const violations = db.prepare(`PRAGMA foreign_key_check(${table})`).all();
    if (violations.length) throw new Error(`Migration left ${violations.length} foreign key violation(s) in ${table}`);
  }
}

/** A consistent copy of an existing database before its schema is upgraded (D-018); kept once per target version. */
function backupBeforeMigrating(db: Db, file: string, version: number): void {
  const target = path.join(path.dirname(file), 'backups', `studio-before-v${version}.db`);
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
