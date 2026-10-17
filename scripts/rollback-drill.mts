/**
 * Rollback drill (docs/v2/MIGRATION_PLAN.md step E) on copies only: snapshot a V1 database, migrate the copy with
 * the V2 code (which writes data/backups/studio-before-v<N>.db), restore that backup into a fresh data dir and open
 * it with the V1 code. Neither the source database nor the V1 checkout is written.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/rollback-drill.mts "<V1 data/studio.db>" "<V1 checkout folder>"
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createStudio } from '../server/src/app.ts';

const [sourceArg, v1Arg] = process.argv.slice(2);
if (!sourceArg || !v1Arg || !fs.existsSync(sourceArg) || !fs.existsSync(path.join(v1Arg, 'server/src/app.ts'))) {
  console.error('Usage: rollback-drill.mts <V1 studio.db> <V1 checkout folder>');
  process.exit(2);
}

const dirs = (name: string): { dataDir: string; dbPath: string; workspacesDir: string; worktreesDir: string; webDistDir: string } => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `asf-drill-${name}-`));
  return { dataDir, dbPath: path.join(dataDir, 'studio.db'), workspacesDir: path.join(dataDir, 'workspaces'),
    worktreesDir: path.join(dataDir, 'worktrees'), webDistDir: path.join(dataDir, 'no-web') };
};
const schemaOf = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version;
  } finally {
    db.close();
  }
};

// 1. V2 migrates a snapshot of the V1 database.
const v2 = dirs('v2');
const reader = new DatabaseSync(path.resolve(sourceArg), { readOnly: true });
reader.exec(`VACUUM INTO '${v2.dbPath.replace(/'/g, "''")}'`);
reader.close();
const sourceSchema = schemaOf(v2.dbPath);
const migrated = await createStudio(v2, { deferRecovery: true });
const v2Projects = (await migrated.app.inject({ url: '/api/projects' })).json().length;
await migrated.close();
const backups = fs.readdirSync(path.join(v2.dataDir, 'backups')).filter((f) => f.startsWith('studio-before-v'));
if (!backups.length) throw new Error('V2 wrote no pre-migration backup');

// 2. Restore the oldest pre-migration backup into a fresh data dir and open it with the V1 code.
const v1 = dirs('v1');
const backup = path.join(v2.dataDir, 'backups', backups.sort()[0]);
fs.copyFileSync(backup, v1.dbPath);
const v1App = await import(pathToFileURL(path.resolve(v1Arg, 'server/src/app.ts')).href);
const restored = await v1App.createStudio(v1, { deferRecovery: true });
const projects = await restored.app.inject({ url: '/api/projects' });
const v1Projects = projects.json().length;
const firstSnapshot = v1Projects ? (await restored.app.inject({ url: `/api/projects/${projects.json()[0].id}` })).statusCode : 200;
await restored.close();

const report = { sourceSchema, migratedSchema: schemaOf(v2.dbPath), backup: path.basename(backup), restoredSchema: schemaOf(v1.dbPath),
  v2Projects, v1Projects, v1SnapshotStatus: firstSnapshot };
console.log(JSON.stringify(report, null, 2));
for (const dir of [v2.dataDir, v1.dataDir]) fs.rmSync(dir, { recursive: true, force: true });
const ok = report.restoredSchema === sourceSchema && v1Projects === v2Projects && firstSnapshot === 200;
console.log(ok ? 'ROLLBACK DRILL OK' : 'ROLLBACK DRILL FAILED');
process.exit(ok ? 0 : 1);
