import type { AgentRole, EventLevel, EventsPage, LogQuery, StudioEvent } from '@asf/shared';
import type { Db } from '../db/database.ts';
import type { StudioContext } from '../orchestrator/context.ts';

// Logs page query (PHASE_6.md, UI_SCREEN_SPECIFICATIONS.md §9). Read-only SQL over `events`; no schema changes.

type Row = Record<string, unknown>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/**
 * The studio's SQLite handle. Read models only see repositories, none of which exposes a free-form query, so the handle
 * is taken from the event repository (it is only `private` at compile time). Replace with a `ctx.db` when one exists.
 */
export function readDb(ctx: StudioContext): Db {
  return ctx.repos.db;
}

const optionalString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const json = (value: unknown): Record<string, unknown> | null =>
  (typeof value === 'string' && value ? (JSON.parse(value) as Record<string, unknown>) : null);

function toEvent(r: Row): StudioEvent {
  return {
    id: Number(r.id), projectId: optionalString(r.project_id), taskId: optionalString(r.task_id), role: (r.role as AgentRole) ?? null,
    type: String(r.type), level: r.level as EventLevel, message: String(r.message), data: json(r.data), createdAt: String(r.created_at),
  };
}

/** Escapes LIKE wildcards; use with `ESCAPE '\'`. */
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Normalised to the stored `toISOString()` form so string comparison is chronological (inputs may lack milliseconds). */
function isoTime(value: string | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Events carry run/session ids in their JSON payload (`runId` / `run.id`, `sessionId` / `session.id`). */
function dataMatch(paths: [string, string]): string {
  return `CASE WHEN json_valid(data) THEN (json_extract(data, '${paths[0]}') = ? OR json_extract(data, '${paths[1]}') = ?) ELSE 0 END`;
}

interface Where { clause: string; params: (string | number)[] }

function buildWhere(q: LogQuery): Where {
  const where: string[] = [];
  const params: (string | number)[] = [];
  const add = (sql: string, ...values: (string | number)[]): void => { where.push(sql); params.push(...values); };

  if (q.projectId) add('project_id = ?', q.projectId);
  if (q.taskId) add('task_id = ?', q.taskId);
  if (q.role) add('role = ?', q.role);
  if (q.level) add('level = ?', q.level);
  if (q.type) {
    if (q.type.endsWith('.*')) add(`type LIKE ? ESCAPE '\\'`, `${likeEscape(q.type.slice(0, -1))}%`);
    else add('type = ?', q.type);
  }
  if (q.q) add(`message LIKE ? ESCAPE '\\'`, `%${likeEscape(q.q)}%`);
  const from = isoTime(q.from);
  if (from) add('created_at >= ?', from);
  const to = isoTime(q.to);
  if (to) add('created_at <= ?', to);
  if (q.runId) {
    add(`(task_id IN (SELECT id FROM tasks WHERE run_id = ?) OR ${dataMatch(['$.runId', '$.run.id'])})`, q.runId, q.runId, q.runId);
  }
  if (q.sessionId) add(`(${dataMatch(['$.sessionId', '$.session.id'])})`, q.sessionId, q.sessionId);
  if (q.before !== undefined) add('id < ?', q.before);
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Newest first; `before` returns ids < before. `nextBefore` is the smallest returned id while older matching rows exist. */
export function queryEvents(ctx: StudioContext, q: LogQuery): EventsPage {
  const { clause, params } = buildWhere(q);
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DEFAULT_LIMIT) || 1, 1), MAX_LIMIT);
  const rows = readDb(ctx).prepare(`SELECT * FROM events ${clause} ORDER BY id DESC LIMIT ?`).all(...params, limit + 1) as Row[];
  const events = rows.slice(0, limit).map(toEvent);
  return { events, nextBefore: rows.length > limit ? events[events.length - 1].id : null };
}
