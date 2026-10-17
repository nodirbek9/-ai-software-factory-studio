import type { Task } from '@asf/shared';
import { fixTaskDescription, type FailureSource } from '../agents/prompts.ts';
import { transaction, type Db } from '../db/database.ts';
import { assertTransition } from '../domain/taskStateMachine.ts';
import { getSettings, type StudioContext } from './context.ts';

export interface FixRound {
  round: number;
  fix: Task;
  requeued: Task;
  shifted: Task[];
}

/** Each verification task (tests, security review, final review) of a run has its own fix-round budget. */
const roundsKey = (runId: string, taskKey: string): string => `fixRounds:${runId}:${taskKey}`;

export function fixRoundsUsed(ctx: StudioContext, runId: string, taskKey: string): number {
  return ctx.repos.config.getSetting<number>(roundsKey(runId, taskKey), 0);
}

/** Fix rounds this verification task may use: its workflow node's limit, else the studio setting. */
export function maxFixRoundsFor(ctx: StudioContext, task: Task): number {
  return task.options.fixRoundsMax ?? getSettings(ctx).maxFixRounds;
}

function uniqueKey(base: string, tasks: Task[]): string {
  const keys = new Set(tasks.map((t) => t.key));
  let key = base;
  for (let n = 2; keys.has(key); n++) key = `${base}-${n}`;
  return key;
}

/**
 * Inserts a fix task (Backend, or Frontend for frontend-only test failures) in front of a failed verification task and re-queues the verification
 * behind it (atomically). Returns null when this verification task has used all of its fix rounds.
 */
/**
 * Test failures that are only in frontend code (web/ package, .tsx/.jsx/.vue specs) go to the Frontend
 * agent; everything else (including review findings) goes to Backend.
 */
export function fixRoleFor(source: FailureSource, findings: string): 'frontend' | 'backend' {
  if (source !== 'tests') return 'backend';
  const failing = [...findings.matchAll(/^\s*FAIL\s+(\S+)/gm)].map((m) => m[1]);
  const workspaces = [...findings.matchAll(/npm (?:error|ERR!) workspace (\S+)/g)].map((m) => m[1]);
  const isWeb = (s: string) => /(^|[\\/@-])(web|frontend|client|ui)([\\/@-]|$)|\.(tsx|jsx|vue)$/i.test(s);
  const signals = [...failing, ...workspaces];
  return signals.length > 0 && signals.every(isWeb) ? 'frontend' : 'backend';
}

export function insertFixTask(ctx: StudioContext, db: Db, failed: Task, source: FailureSource, findings: string): FixRound | null {
  const settings = getSettings(ctx);
  const used = fixRoundsUsed(ctx, failed.runId, failed.key);
  if (used >= maxFixRoundsFor(ctx, failed)) return null;
  assertTransition(failed.status, 'pending');
  const round = used + 1;
  const tasks = ctx.repos.tasks.listByRun(failed.runId);
  const key = uniqueKey(`fix-${failed.key}-${round}`, tasks);
  const fixRole = failed.options.fixRole;
  const role = fixRole === 'backend' || fixRole === 'frontend' ? fixRole : fixRoleFor(source, findings);

  return transaction(db, () => {
    ctx.repos.config.setSetting(roundsKey(failed.runId, failed.key), round);
    const shifted = tasks.filter((t) => t.orderIndex >= failed.orderIndex && t.id !== failed.id)
      .map((t) => ctx.repos.tasks.update(t.id, { orderIndex: t.orderIndex + 1 }));
    const fix = ctx.repos.tasks.create(failed.projectId, {
      runId: failed.runId, nodeId: null, key, title: `Fix round ${round}: ${failed.title}`,
      description: fixTaskDescription(failed, source, findings, round), role, kind: 'implement', dependsOn: failed.dependsOn,
      orderIndex: failed.orderIndex, maxAttempts: settings.defaultMaxAttempts,
    });
    const requeued = ctx.repos.tasks.update(failed.id, {
      status: 'pending', dependsOn: [fix.key], orderIndex: failed.orderIndex + 1,
      maxAttempts: Math.max(failed.maxAttempts, failed.attempt + 1),
    });
    return { round, fix, requeued, shifted };
  });
}
