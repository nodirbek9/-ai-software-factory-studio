import fs from 'node:fs';
import os from 'node:os';
import type { HealthState, SystemHealth } from '@asf/shared';
import type { EventStream } from '../events/eventStream.ts';
import type { StudioContext } from '../orchestrator/context.ts';
import { STUDIO_VERSION } from '../version.ts';
import { runProcess } from '../workspace/processRunner.ts';

type Check = SystemHealth['checks'][number];

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const DISK_DEGRADED_BYTES = 2 * GB;
const DISK_DOWN_BYTES = 500 * MB;
const GIT_TIMEOUT_MS = 5_000;
const SEVERITY: Record<HealthState, number> = { ok: 0, degraded: 1, down: 2 };

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

// `git --version` runs once per process; later health calls reuse the answer.
let gitCheck: Promise<Pick<Check, 'state' | 'detail'>> | null = null;
function checkGit(cwd: string): Promise<Pick<Check, 'state' | 'detail'>> {
  gitCheck ??= runProcess('git', { cwd, args: ['--version'], timeoutMs: GIT_TIMEOUT_MS })
    .then((r): Pick<Check, 'state' | 'detail'> => (r.exitCode === 0
      ? { state: 'ok', detail: r.stdout.trim() || 'git available' }
      : { state: 'down', detail: r.timedOut ? 'git --version timed out' : `git --version exited with ${r.exitCode}` }))
    .catch((error: Error): Pick<Check, 'state' | 'detail'> => ({ state: 'down', detail: error.message }));
  return gitCheck;
}

// CPU usage is the busy share between two os.cpus() samples, so the first call has no value yet.
let lastCpu: { idle: number; total: number } | null = null;
function cpuPercent(): number | null {
  const sample = os.cpus().reduce((acc, cpu) => {
    const { user, nice, sys, idle, irq } = cpu.times;
    return { idle: acc.idle + idle, total: acc.total + user + nice + sys + idle + irq };
  }, { idle: 0, total: 0 });
  const previous = lastCpu;
  if (previous && sample.total <= previous.total) return null; // no time has passed since the last sample
  lastCpu = sample;
  if (!previous) return null;
  const busy = 1 - (sample.idle - previous.idle) / (sample.total - previous.total);
  return Math.round(Math.min(Math.max(busy, 0), 1) * 1000) / 10;
}

function databaseCheck(ctx: StudioContext): Check {
  const label = 'Database';
  try {
    if (!ctx.repos.config.ping()) return { id: 'database', label, state: 'down', detail: 'No answer to SELECT 1' };
    const size = [ctx.config.dbPath, `${ctx.config.dbPath}-wal`].reduce((sum, file) => {
      try { return sum + fs.statSync(file).size; } catch { return sum; }
    }, 0);
    return { id: 'database', label, state: 'ok', detail: `SQLite ${formatBytes(size)}` };
  } catch (error) {
    return { id: 'database', label, state: 'down', detail: error instanceof Error ? error.message : String(error) };
  }
}

function diskCheck(dir: string): Check {
  const label = 'Disk space';
  try {
    const stats = fs.statfsSync(dir);
    const free = stats.bavail * stats.bsize;
    const state: HealthState = free < DISK_DOWN_BYTES ? 'down' : free < DISK_DEGRADED_BYTES ? 'degraded' : 'ok';
    return { id: 'disk', label, state, detail: `${formatBytes(free)} free` };
  } catch (error) {
    return { id: 'disk', label, state: 'degraded', detail: `Free space unknown: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Studio and machine health for the sidebar. Providers: cached detection of enabled ones only (never forced). */
export async function buildSystemHealth(ctx: StudioContext, events: EventStream): Promise<SystemHealth> {
  const providers = (await ctx.registry.statusList()).filter((p) => p.isAi && p.enabled);
  const usable = providers.filter((p) => p.available).length;
  const providerState: HealthState = !providers.length || !usable ? 'down' : usable === providers.length ? 'ok' : 'degraded';
  const git = await checkGit(ctx.config.dataDir);
  const clients = events.clientCount;

  const checks: Check[] = [
    { id: 'api', label: 'API server', state: 'ok', detail: `Responding · v${STUDIO_VERSION}` },
    databaseCheck(ctx),
    { id: 'events', label: 'Live events', state: 'ok', detail: `${clients} live client${clients === 1 ? '' : 's'}` },
    { id: 'providers', label: 'AI providers', state: providerState,
      detail: providers.length ? `${usable} of ${providers.length} usable` : 'No AI provider enabled' },
    { id: 'git', label: 'Git', ...git },
    diskCheck(ctx.config.dataDir),
  ];

  return {
    generatedAt: new Date().toISOString(),
    overall: checks.reduce<HealthState>((worst, c) => (SEVERITY[c.state] > SEVERITY[worst] ? c.state : worst), 'ok'),
    checks,
    server: { rssBytes: process.memoryUsage().rss, uptimeSec: Math.round(process.uptime()), version: STUDIO_VERSION },
    system: { totalMemBytes: os.totalmem(), freeMemBytes: os.freemem(), cpuPercent: cpuPercent() },
    eventClients: clients,
  };
}
