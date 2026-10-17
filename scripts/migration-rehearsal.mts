/**
 * Migration rehearsal (docs/v2/MIGRATION_PLAN.md step C): snapshot a V1 database with VACUUM INTO into a temp data
 * dir, open it with the V2 server code without recovery or the scheduler, check the migrated rows and time the
 * read endpoints the V2 UI calls. The source database is only read.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/migration-rehearsal.mts "<path to V1 data/studio.db>"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../server/src/app.ts';

const source = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(source)) {
  console.error('Usage: migration-rehearsal.mts <V1 studio.db>');
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asf-rehearsal-'));
const target = path.join(dataDir, 'studio.db');
const reader = new DatabaseSync(source, { readOnly: true });
const before = {
  schemaVersion: (reader.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)?.version ?? 0,
  projects: (reader.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n,
  tasks: (reader.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n,
  events: (reader.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n,
};
reader.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
reader.close();

const studio = await createStudio({ dataDir, dbPath: target, workspacesDir: path.join(dataDir, 'workspaces'),
  worktreesDir: path.join(dataDir, 'worktrees'), webDistDir: path.join(dataDir, 'no-web') }, { deferRecovery: true });
const db = new DatabaseSync(target, { readOnly: true });
const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
const after = {
  schemaVersion: (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
  projects: count('SELECT COUNT(*) AS n FROM projects'),
  tasks: count('SELECT COUNT(*) AS n FROM tasks'),
  tasksWithoutRun: count('SELECT COUNT(*) AS n FROM tasks WHERE run_id IS NULL'),
  runs: count('SELECT COUNT(*) AS n FROM runs'),
  events: count('SELECT COUNT(*) AS n FROM events'),
  foreignKeyProblems: (db.prepare('PRAGMA foreign_key_check').all()).length,
  integrity: (db.prepare('PRAGMA integrity_check').get() as Record<string, string>).integrity_check,
};

async function timed(url: string): Promise<string> {
  const started = performance.now();
  const response = await studio.app.inject({ url });
  return `${response.statusCode} ${(response.body.length / 1024).toFixed(0).padStart(5)} KB ${(performance.now() - started).toFixed(0).padStart(4)} ms  ${url}`;
}

const lines: string[] = [];
const projectIds = (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map((row) => row.id);
for (const url of ['/api/projects', '/api/v2/overview', '/api/v2/tasks?limit=50', '/api/v2/events?limit=200', '/api/v2/usage/summary?range=7d',
  '/api/v2/workflows/catalog']) lines.push(await timed(url));
for (const id of projectIds) {
  lines.push(await timed(`/api/projects/${id}`));
  lines.push(await timed(`/api/v2/overview?projectId=${id}`));
  lines.push(await timed(`/api/v2/projects/${id}/runs`));
  lines.push(await timed(`/api/v2/projects/${id}/quality`));
}
db.close();
await studio.close();

console.log(JSON.stringify({ source, dataDir, before, after }, null, 2));
console.log(lines.join('\n'));
const backups = fs.existsSync(path.join(dataDir, 'backups')) ? fs.readdirSync(path.join(dataDir, 'backups')) : [];
console.log(`pre-migration backups: ${backups.join(', ') || 'none'}`);
const ok = after.projects === before.projects && after.tasks === before.tasks && after.tasksWithoutRun === 0
  && after.foreignKeyProblems === 0 && after.integrity === 'ok';
console.log(ok ? 'REHEARSAL OK' : 'REHEARSAL FAILED');
fs.rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
