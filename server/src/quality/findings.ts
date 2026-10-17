import { z } from 'zod';
import type { Finding, FindingSeverity, FindingSource, Task } from '@asf/shared';
import type { StudioContext } from '../orchestrator/context.ts';
import { redact } from '../security/redact.ts';

// Structured findings from security/review agent output (PHASE_6 P6-1). Output without findings produces none — never invented.

export interface ParsedFinding {
  severity: FindingSeverity;
  title: string;
  file: string | null;
  line: number | null;
  description: string;
  recommendation: string | null;
}

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_RECOMMENDATION = 2000;
const MAX_FILE = 300;
/** Upper bound of findings taken from one agent reply. */
const MAX_FINDINGS = 200;

const SEVERITY_ALIASES: Record<string, FindingSeverity> = {
  critical: 'critical', high: 'high', medium: 'medium', moderate: 'medium', low: 'low',
  info: 'info', informational: 'info', note: 'info',
};

/** Lower-cases a reported severity and maps its aliases (moderate → medium, informational/note → info); null when unknown. */
export function normaliseSeverity(value: string): FindingSeverity | null {
  return SEVERITY_ALIASES[value.trim().toLowerCase()] ?? null;
}

const clip = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

function lineOf(value: number | string | null | undefined): number | null {
  const line = typeof value === 'string' ? Number(value.trim()) : value;
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 ? line : null;
}

function fileOf(value: string | null | undefined): string | null {
  const file = oneLine(redact(value ?? '')).replace(/^`+|`+$/g, '');
  return file && file.toLowerCase() !== 'null' ? clip(file, MAX_FILE) : null;
}

export interface RawFinding {
  severity: string;
  title: string;
  file?: string | null;
  line?: number | string | null;
  description?: string | null;
  recommendation?: string | null;
}

/** Redacts and clamps one reported finding; null when its severity is unknown or its title is empty. */
export function normaliseFinding(raw: RawFinding): ParsedFinding | null {
  const severity = normaliseSeverity(raw.severity);
  const title = clip(oneLine(redact(raw.title)), MAX_TITLE);
  if (!severity || !title) return null;
  const recommendation = clip(redact(raw.recommendation ?? '').trim(), MAX_RECOMMENDATION);
  return {
    severity, title, file: fileOf(raw.file), line: lineOf(raw.line),
    description: clip(redact(raw.description ?? '').trim(), MAX_DESCRIPTION), recommendation: recommendation || null,
  };
}

const rawFindingSchema = z.object({
  severity: z.string(),
  title: z.string(),
  file: z.string().nullish(),
  line: z.union([z.number(), z.string()]).nullish(),
  description: z.string().nullish(),
  recommendation: z.string().nullish(),
});

/** The body of the last ```asf-findings fenced block, or null when the reply has none. */
function lastFindingsBlock(text: string): string | null {
  const blocks = [...text.matchAll(/```asf-findings[^\S\r\n]*\r?\n([\s\S]*?)```/g)];
  return blocks.at(-1)?.[1] ?? null;
}

/** Findings of a JSON block; null when it is not a JSON array (the caller falls back to bullet lines). */
function parseBlock(body: string): ParsedFinding[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = (value as { findings?: unknown }).findings;
  if (!Array.isArray(value)) return null;
  const findings: ParsedFinding[] = [];
  for (const item of value) {
    const parsed = rawFindingSchema.safeParse(item);
    const finding = parsed.success ? normaliseFinding(parsed.data) : null;
    if (finding) findings.push(finding);
  }
  return findings.slice(0, MAX_FINDINGS);
}

const BULLET = /^\s*[-*]\s*\**(CRITICAL|HIGH|MEDIUM|MODERATE|LOW|INFO)\**\s*[:\-–]\s*(.+)$/gim;
const LOCATION = /^`([^`]+)`\s*[:\-–,]?\s*/;

/** A backticked token is a file when it has no spaces/brackets and a path separator or an extension. */
function splitLocation(token: string): { file: string; line: number | null } | null {
  const [, file, line] = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(token.trim()) ?? [];
  if (!file || !/^[^\s()<>'"]+$/.test(file)) return null;
  if (!/[\\/]/.test(file) && !/\.[A-Za-z0-9]{1,8}$/.test(file)) return null;
  return { file, line: lineOf(line) };
}

function firstSentence(text: string): string {
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(text)?.[1] ?? text;
  return sentence.replace(/\.$/, '');
}

/** V1 format: `- HIGH: \`file:line\` text` (bold markers and the location are optional). */
function bulletFinding(severity: string, line: string): ParsedFinding | null {
  let rest = line.replace(/^\*+\s*/, '').trim();
  let location: { file: string; line: number | null } | null = null;
  const located = LOCATION.exec(rest);
  if (located) {
    location = splitLocation(located[1]);
    if (location) rest = rest.slice(located[0].length).trim();
  }
  return normaliseFinding({
    severity, title: firstSentence(rest) || location?.file || '', file: location?.file ?? null,
    line: location?.line ?? null, description: rest,
  });
}

function parseBullets(text: string): ParsedFinding[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const findings: ParsedFinding[] = [];
  for (const match of prose.matchAll(BULLET)) {
    const finding = bulletFinding(match[1], match[2]);
    if (finding) findings.push(finding);
    if (findings.length >= MAX_FINDINGS) break;
  }
  return findings;
}

/** Findings of an agent reply: the last ```asf-findings JSON block, else the V1 bullet lines; [] when there are none. */
export function parseFindings(text: string): ParsedFinding[] {
  return parseFindingsReport(text).findings;
}

/** parseFindings plus whether the reply carried an `asf-findings` block that is not valid JSON findings. */
export function parseFindingsReport(text: string): { findings: ParsedFinding[]; malformed: boolean } {
  const block = lastFindingsBlock(text);
  const fromBlock = block === null ? null : parseBlock(block);
  return { findings: fromBlock ?? parseBullets(text), malformed: block !== null && fromBlock === null };
}

/** Identity of a finding across re-runs: lower-case `source|file|title`, whitespace collapsed. */
export function fingerprintOf(f: { source: FindingSource; file: string | null; title: string }): string {
  return [f.source, f.file ?? '', f.title].map((part) => oneLine(part.toLowerCase())).join('|');
}

/** Stores the findings a security/review task reported (P6-1 re-run semantics) and announces the change. */
export function ingestTaskFindings(ctx: StudioContext, task: Task, text: string, source: 'security' | 'review',
  verdict: 'pass' | 'fail' | null = null): Finding[] {
  const report = parseFindingsReport(text);
  // Re-run semantics close earlier findings that are not reported again, so only a reliable report may do that: a
  // malformed findings block, or a FAIL verdict with no finding parsed, keeps the earlier findings as they are (P7-S5).
  const unreliable = report.malformed ? 'its findings block is not valid JSON'
    : verdict === 'fail' && report.findings.length === 0 ? 'it failed without a finding the studio could read' : null;
  if (unreliable) {
    ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'findings.error', level: 'warn',
      message: `Kept the earlier ${source} findings: ${unreliable}`, data: { runId: task.runId, taskId: task.id } });
    return [];
  }
  const findings = ctx.repos.findings.replaceForTask({
    projectId: task.projectId, runId: task.runId, taskId: task.id, source, findings: report.findings,
  });
  ctx.events.emit({ projectId: task.projectId, taskId: task.id, role: task.role, type: 'findings.updated', level: 'info',
    message: `${findings.length} ${source} finding(s) recorded`, data: { runId: task.runId, taskId: task.id, count: findings.length } });
  return findings;
}
