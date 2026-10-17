import { randomUUID } from 'node:crypto';
import type { Finding, FindingQuery, FindingSeverity, FindingSource, FindingStatus, FindingsResponse } from '@asf/shared';
import { FINDING_SEVERITIES } from '@asf/shared';
import type { Db } from './database.ts';
import { fingerprintOf, type ParsedFinding } from '../quality/findings.ts';
import { redact } from '../security/redact.ts';

// Quality findings (PHASE_6 P6-1): security/review agent output per run task, and npm audit results per project.

type Row = Record<string, unknown>;

const now = (): string => new Date().toISOString();
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
const SEVERITY_RANK = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
/** Statuses a later report that no longer lists the finding turns into `fixed`; user decisions are kept. */
const CLOSABLE: readonly FindingStatus[] = ['open', 'fix_planned'];

function toFinding(r: Row): Finding {
  return {
    id: String(r.id), projectId: String(r.project_id), runId: str(r.run_id), taskId: str(r.task_id),
    source: r.source as FindingSource, severity: r.severity as FindingSeverity, title: String(r.title), file: str(r.file),
    line: r.line === null || r.line === undefined ? null : Number(r.line), description: String(r.description),
    recommendation: str(r.recommendation), status: r.status as FindingStatus, note: str(r.note), fixTaskId: str(r.fix_task_id),
    createdAt: String(r.created_at), updatedAt: String(r.updated_at),
  };
}

const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function whereOf(query: FindingQuery, withSeverity: boolean): { clause: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (query.projectId) { where.push('project_id = ?'); params.push(query.projectId); }
  if (query.runId) { where.push('run_id = ?'); params.push(query.runId); }
  if (withSeverity && query.severity) { where.push('severity = ?'); params.push(query.severity); }
  if (query.source) { where.push('source = ?'); params.push(query.source); }
  if (query.status) { where.push('status = ?'); params.push(query.status); }
  const q = query.q?.trim();
  if (q) {
    where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR COALESCE(file, '') LIKE ? ESCAPE '\\')");
    params.push(likePattern(q), likePattern(q), likePattern(q));
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Where the findings of one report are written: the report's run/task, and the earlier rows it replaces. */
interface Target {
  projectId: string;
  runId: string | null;
  taskId: string | null;
  source: FindingSource;
  /** Earlier findings of the same scope, newest first. */
  previous: Row[];
}

export class FindingRepository {
  constructor(private readonly db: Db) {}

  /** Findings matching the filter, most severe first, then newest; counts ignore the severity filter. */
  list(query: FindingQuery): FindingsResponse {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const filtered = whereOf(query, true);
    const rows = this.db.prepare(`SELECT * FROM findings ${filtered.clause} ORDER BY ${SEVERITY_RANK}, created_at DESC, rowid DESC
      LIMIT ?`).all(...filtered.params, limit + 1) as Row[];
    const counted = whereOf(query, false);
    const counts = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<FindingSeverity, number>;
    const grouped = this.db.prepare(`SELECT severity, COUNT(*) AS n FROM findings ${counted.clause} GROUP BY severity`)
      .all(...counted.params) as Row[];
    for (const r of grouped) if (String(r.severity) in counts) counts[r.severity as FindingSeverity] = Number(r.n);
    return { findings: rows.slice(0, limit).map(toFinding), counts, truncated: rows.length > limit };
  }

  get(id: string): Finding | null {
    const row = this.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as Row | undefined;
    return row ? toFinding(row) : null;
  }

  listByRun(runId: string): Finding[] {
    return (this.db.prepare(`SELECT * FROM findings WHERE run_id = ? ORDER BY ${SEVERITY_RANK}, created_at DESC, rowid DESC`)
      .all(runId) as Row[]).map(toFinding);
  }

  update(id: string, patch: { status?: FindingStatus; note?: string | null; fixTaskId?: string | null }): Finding {
    const sets: string[] = [];
    const values: (string | null)[] = [];
    if (patch.status !== undefined) { sets.push('status = ?'); values.push(patch.status); }
    if (patch.note !== undefined) { sets.push('note = ?'); values.push(patch.note === null ? null : redact(patch.note)); }
    if (patch.fixTaskId !== undefined) { sets.push('fix_task_id = ?'); values.push(patch.fixTaskId); }
    if (sets.length) this.db.prepare(`UPDATE findings SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, now(), id);
    const finding = this.get(id);
    if (!finding) throw new Error(`Finding ${id} was not found`);
    return finding;
  }

  /**
   * Stores what one run of a security/review task reported. Matches (by fingerprint) the run's earlier findings of the
   * same task key — a fix round re-runs the same task, a new run starts over — keeping their status and note; earlier
   * open/fix_planned findings not reported again become `fixed`. Returns the reported findings.
   */
  replaceForTask(input: { projectId: string; runId: string; taskId: string; source: 'security' | 'review'; findings: ParsedFinding[] }): Finding[] {
    return this.savepoint(() => {
      const previous = this.db.prepare(`SELECT * FROM findings WHERE run_id = ? AND source = ? AND (task_id = ? OR task_id IN
        (SELECT id FROM tasks WHERE run_id = ? AND key = (SELECT key FROM tasks WHERE id = ?))) ORDER BY created_at DESC, rowid DESC`)
        .all(input.runId, input.source, input.taskId, input.runId, input.taskId) as Row[];
      return this.sync({ ...input, previous }, input.findings);
    });
  }

  /** Stores one `npm audit` result; the project's earlier open audit findings not reported again become `fixed`. */
  addAudit(input: { projectId: string; runId: string | null; findings: ParsedFinding[] }): Finding[] {
    return this.savepoint(() => {
      const previous = this.db.prepare(`SELECT * FROM findings WHERE project_id = ? AND source = 'audit'
        ORDER BY created_at DESC, rowid DESC`).all(input.projectId) as Row[];
      return this.sync({ projectId: input.projectId, runId: input.runId, taskId: null, source: 'audit', previous }, input.findings);
    });
  }

  private sync(target: Target, findings: ParsedFinding[]): Finding[] {
    const earlier = new Map<string, Row>();
    for (const row of target.previous) if (!earlier.has(String(row.fingerprint))) earlier.set(String(row.fingerprint), row);
    const kept = new Map<string, string>();
    for (const finding of findings) {
      const fingerprint = fingerprintOf({ source: target.source, file: finding.file, title: finding.title });
      if (kept.has(fingerprint)) continue; // one row per fingerprint and scope
      const match = earlier.get(fingerprint);
      kept.set(fingerprint, match ? this.refresh(String(match.id), target, finding) : this.insert(target, finding, fingerprint));
    }
    const ids = new Set(kept.values());
    const close = this.db.prepare(`UPDATE findings SET status = 'fixed', updated_at = ? WHERE id = ?`);
    for (const row of target.previous) {
      if (!ids.has(String(row.id)) && CLOSABLE.includes(row.status as FindingStatus)) close.run(now(), String(row.id));
    }
    return [...ids].map((id) => this.get(id)!);
  }

  private insert(target: Target, f: ParsedFinding, fingerprint: string): string {
    const id = randomUUID();
    const ts = now();
    this.db.prepare(`INSERT INTO findings (id, project_id, run_id, task_id, source, severity, title, file, line, description,
      recommendation, status, fingerprint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
      .run(id, target.projectId, target.runId, target.taskId, target.source, f.severity, redact(f.title), f.file, f.line,
        redact(f.description), f.recommendation === null ? null : redact(f.recommendation), fingerprint, ts, ts);
    return id;
  }

  /** Updates the text of a finding reported again; its status and note stay (a `fixed` one that is back reopens). */
  private refresh(id: string, target: Target, f: ParsedFinding): string {
    this.db.prepare(`UPDATE findings SET run_id = ?, task_id = ?, severity = ?, title = ?, file = ?, line = ?, description = ?,
      recommendation = ?, status = CASE status WHEN 'fixed' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?`)
      .run(target.runId, target.taskId, f.severity, redact(f.title), f.file, f.line, redact(f.description),
        f.recommendation === null ? null : redact(f.recommendation), now(), id);
    return id;
  }

  /** A nestable transaction (callers may already hold one). */
  private savepoint<T>(work: () => T): T {
    this.db.exec('SAVEPOINT findings_write');
    try {
      const result = work();
      this.db.exec('RELEASE findings_write');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK TO findings_write; RELEASE findings_write');
      throw error;
    }
  }
}
