import { FINDING_SEVERITIES, type FindingSeverity, type Project } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { redact } from '../security/redact.ts';
import { parseCommand } from '../workspace/commandRunner.ts';
import { commandEnv, runProcess } from '../workspace/processRunner.ts';
import type { ParsedFinding } from './findings.ts';

// Dependency audit (PHASE_6.md P6-3): `npm audit --json` needs network access, so it only runs after the user approved it
// (projectService.decideApproval → QualityService.startAudit). The command runner is injectable: tests never hit the network.

export const AUDIT_COMMAND = 'npm audit --json';
export const AUDIT_TIMEOUT_MS = 5 * 60_000;
const ERROR_MAX = 500;
const DESCRIPTION_MAX = 4000;

export interface AuditCommandResult {
  exitCode: number | null;
  /** Full stdout: the JSON report can be far longer than a test command's output tail. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type AuditCommandRunner = (command: string, cwd: string, options: { timeoutMs: number; approved: true }) => Promise<AuditCommandResult>;

export interface AuditDeps {
  run: AuditCommandRunner;
}

/** Result of the project's latest audit, stored in settings key `quality:lastAudit:<projectId>`. */
export interface LastAudit {
  at: string;
  ok: boolean;
  error: string | null;
  counts: Record<FindingSeverity, number>;
}

export const lastAuditKey = (projectId: string): string => `quality:lastAudit:${projectId}`;

export function readLastAudit(ctx: StudioContext, projectId: string): LastAudit | null {
  return ctx.repos.config.getSetting<LastAudit | null>(lastAuditKey(projectId), null);
}

/** Runs the (approved) command with argv only and keeps all of stdout; a non-zero exit is normal when vulnerabilities exist. */
export const runAuditCommand: AuditCommandRunner = async (command, cwd, { timeoutMs }) => {
  const [exe, ...args] = parseCommand(command);
  const result = await runProcess(exe, { cwd, args, env: commandEnv(), timeoutMs });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
};

export const DEFAULT_AUDIT_DEPS: AuditDeps = { run: runAuditCommand };

// ------------------------------------------------------------------ parsing

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const SEVERITY_RANK = new Map<FindingSeverity, number>(FINDING_SEVERITIES.map((s, i) => [s, i]));

/** npm severities: critical/high/moderate/low/info → the studio's scale (moderate = medium). */
function severityOf(value: unknown): FindingSeverity {
  const severity = text(value).toLowerCase();
  if (severity === 'moderate') return 'medium';
  return (FINDING_SEVERITIES as readonly string[]).includes(severity) ? (severity as FindingSeverity) : 'info';
}

const worst = (a: FindingSeverity, b: FindingSeverity): FindingSeverity => (SEVERITY_RANK.get(a)! <= SEVERITY_RANK.get(b)! ? a : b);

function parseJson(raw: string): Json {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('npm audit printed no JSON report');
  const attempts = [trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)];
  for (const candidate of attempts) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      // try the next candidate (npm may print a warning line before the report)
    }
  }
  throw new Error(`npm audit did not print a valid JSON report: ${trimmed.slice(0, 200)}`);
}

function recommendationOf(name: string, fix: unknown): string {
  if (fix === true) return 'Run `npm audit fix` to install a fixed version.';
  if (isObject(fix)) {
    const target = `${text(fix.name) || name}${text(fix.version) ? `@${text(fix.version)}` : ''}`;
    return `Update ${target} (\`npm audit fix --force\`${fix.isSemVerMajor ? '; a semver-major change, check for breaking changes' : ''}).`;
  }
  return `No fix is available yet: replace ${name}, or accept the risk with a note.`;
}

/** npm 7+ (`auditReportVersion` 2): one finding per vulnerable package. */
function fromVulnerabilities(vulnerabilities: Json): ParsedFinding[] {
  return Object.entries(vulnerabilities).filter(([, v]) => isObject(v)).map(([name, raw]) => {
    const entry = raw as Json;
    const via = Array.isArray(entry.via) ? entry.via : [];
    const advisories = via.filter(isObject);
    const through = via.filter((v): v is string => typeof v === 'string');
    const firstTitle = advisories.map((a) => text(a.title)).find(Boolean);
    const lines = [
      ...advisories.map((a) => `${text(a.title) || 'Advisory'}${text(a.url) ? ` (${text(a.url)})` : ''}`),
      ...(through.length ? [`Vulnerable through: ${through.join(', ')}`] : []),
      ...(text(entry.range) ? [`Affected versions: ${text(entry.range)}`] : []),
    ];
    return {
      severity: severityOf(entry.severity), title: `${name}: ${firstTitle ?? `vulnerable dependency (via ${through.join(', ') || 'unknown'})`}`,
      file: 'package-lock.json', line: null, description: lines.join('\n').slice(0, DESCRIPTION_MAX),
      recommendation: recommendationOf(name, entry.fixAvailable),
    };
  });
}

/** npm 6 (`advisories`): advisories grouped per module, the worst severity wins. */
function fromAdvisories(advisories: Json): ParsedFinding[] {
  const byModule = new Map<string, Json[]>();
  for (const advisory of Object.values(advisories).filter(isObject)) {
    const name = text(advisory.module_name) || 'unknown package';
    byModule.set(name, [...(byModule.get(name) ?? []), advisory]);
  }
  return [...byModule].map(([name, list]) => {
    const severity = list.map((a) => severityOf(a.severity)).reduce(worst);
    const lines = list.map((a) => `${text(a.title) || 'Advisory'}${text(a.url) ? ` (${text(a.url)})` : ''}`
      + `${text(a.vulnerable_versions) ? ` — affected versions ${text(a.vulnerable_versions)}` : ''}`);
    return {
      severity, title: `${name}: ${text(list[0].title) || 'vulnerable dependency'}`, file: 'package-lock.json', line: null,
      description: lines.join('\n').slice(0, DESCRIPTION_MAX),
      recommendation: list.map((a) => text(a.recommendation)).find(Boolean) ?? null,
    };
  });
}

const bySeverityThenTitle = (a: ParsedFinding, b: ParsedFinding): number =>
  SEVERITY_RANK.get(a.severity)! - SEVERITY_RANK.get(b.severity)! || a.title.localeCompare(b.title);

/** Parses `npm audit --json` (npm 7+ and npm 6 formats). Throws a clear error for invalid JSON or an npm error report. */
export function parseNpmAudit(json: string): ParsedFinding[] {
  const report = parseJson(json);
  if (isObject(report.error)) {
    const summary = text(report.error.summary) || text(report.error.detail) || text(report.error.code) || 'unknown error';
    throw new Error(`npm audit failed: ${summary}`);
  }
  if (isObject(report.vulnerabilities)) return fromVulnerabilities(report.vulnerabilities).sort(bySeverityThenTitle);
  if (isObject(report.advisories)) return fromAdvisories(report.advisories).sort(bySeverityThenTitle);
  throw new Error('npm audit printed an unrecognised report (no "vulnerabilities" or "advisories")');
}

// ------------------------------------------------------------------ running

export function countBySeverity(findings: { severity: FindingSeverity }[]): Record<FindingSeverity, number> {
  const counts = Object.fromEntries(FINDING_SEVERITIES.map((s) => [s, 0])) as Record<FindingSeverity, number>;
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function report(output: AuditCommandResult): string {
  if (output.timedOut) throw new Error(`npm audit timed out after ${AUDIT_TIMEOUT_MS / 60_000} minutes`);
  if (output.stdout.trim()) return output.stdout;
  const stderr = output.stderr.trim().split(/\r?\n/).slice(-3).join(' ');
  throw new Error(`npm audit printed no report (exit ${output.exitCode})${stderr ? `: ${stderr}` : ''}`);
}

/**
 * Runs `npm audit --json` once in the project's integration worktree, stores the findings (source `audit`) on the
 * project's current run and records the outcome. Never throws: a failure is recorded as `{ ok: false, error }`.
 */
export async function runAudit(ctx: StudioContext, project: Project, deps: AuditDeps = DEFAULT_AUDIT_DEPS): Promise<LastAudit> {
  const run = ctx.repos.runs.activeForProject(project.id) ?? ctx.repos.runs.latestForProject(project.id);
  let result: LastAudit;
  try {
    const output = await deps.run(AUDIT_COMMAND, project.integrationPath ?? project.workspacePath, { timeoutMs: AUDIT_TIMEOUT_MS, approved: true });
    const findings = parseNpmAudit(report(output));
    ctx.repos.findings.addAudit({ projectId: project.id, runId: run?.id ?? null, findings });
    result = { at: new Date().toISOString(), ok: true, error: null, counts: countBySeverity(findings) };
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);
    result = { at: new Date().toISOString(), ok: false, error: message, counts: countBySeverity([]) };
  }
  ctx.repos.config.setSetting(lastAuditKey(project.id), result);
  const total = Object.values(result.counts).reduce((sum, n) => sum + n, 0);
  ctx.events.emit({ projectId: project.id, type: 'quality.audit', level: result.ok ? 'info' : 'warn',
    message: result.ok ? `npm audit: ${total} vulnerable package(s)` : `npm audit failed: ${result.error}`, data: { audit: result } });
  return result;
}
