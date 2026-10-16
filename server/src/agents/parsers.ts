import { z } from 'zod';
import type { FileEdit } from '../workspace/workspaceManager.ts';

export class AgentOutputError extends Error {}

/** Extracts the first JSON object from model output (handles ```json fences and surrounding prose). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try next candidate
    }
  }
  throw new AgentOutputError('Agent output did not contain a valid JSON object');
}

const KEY = z.string().trim().min(1).max(60).regex(/^[a-z0-9][a-z0-9-]*$/, 'keys must be kebab-case');

export const planSchema = z.object({
  tasks: z.array(z.object({
    key: KEY,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(4000).default(''),
    role: z.enum(['backend', 'frontend', 'qa']),
    dependsOn: z.array(KEY).default([]),
  })).min(1).max(20),
});

export type PlanOutput = z.infer<typeof planSchema>;

export function parsePlan(text: string): PlanOutput {
  const result = planSchema.safeParse(extractJson(text));
  if (!result.success) throw new AgentOutputError(`Invalid plan JSON: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return result.data;
}

const fileProtocolSchema = z.object({
  summary: z.string().max(4000).default(''),
  files: z.array(z.object({
    path: z.string().min(1).max(300),
    content: z.string().max(1_000_000).optional(),
    delete: z.boolean().optional(),
  })).max(100),
});

export function parseFileProtocol(text: string): { summary: string; files: FileEdit[] } {
  const result = fileProtocolSchema.safeParse(extractJson(text));
  if (!result.success) throw new AgentOutputError(`Invalid file-edit JSON: ${result.error.issues[0]?.message ?? 'unknown'}`);
  return result.data;
}

export function parseVerdict(text: string): 'pass' | 'fail' | null {
  const match = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)/gi)].at(-1);
  return match ? (match[1].toUpperCase() === 'PASS' ? 'pass' : 'fail') : null;
}

export function summarize(text: string, max = 600): string {
  const clean = text.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
