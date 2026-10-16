import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import * as processRunner from '../src/workspace/processRunner.ts';
import { ClaudeCodeProvider, CodexProvider } from '../src/providers/cliProviders.ts';
import { extractJson, parsePlan, parseVerdict } from '../src/agents/parsers.ts';
import { loadConfig } from '../src/config.ts';
import { validateGraph } from '../src/domain/taskGraph.ts';
import { assertTransition, canTransition } from '../src/domain/taskStateMachine.ts';
import { redact, registerSecret } from '../src/security/redact.ts';
import { failureDigest, isAllowedCommand, parseCommand, summarizeTestOutput } from '../src/workspace/commandRunner.ts';
import { fixRoleFor } from '../src/orchestrator/fixLoop.ts';
import { commitAll, git } from '../src/workspace/git.ts';
import { WorkspaceManager } from '../src/workspace/workspaceManager.ts';
import { tempDir } from './helpers.ts';

describe('CLI reasoning token usage', () => {
  test.each([
    ['claude details', new ClaudeCodeProvider(), { type: 'result', result: '1591', usage: {
      output_tokens: 133, output_tokens_details: { thinking_tokens: 129 } } }, 129],
    ['claude model usage', new ClaudeCodeProvider(), { type: 'result', result: '1591',
      modelUsage: { 'claude-haiku-5-5': { outputTokens: 133, thinkingTokens: 129 } } }, 129],
    ['codex zero', new CodexProvider(), { type: 'turn.completed', usage: { input_tokens: 14481,
      cached_input_tokens: 12544, output_tokens: 5, reasoning_output_tokens: 0 } }, 0],
    ['codex thinking', new CodexProvider(), { type: 'turn.completed', usage: { reasoning_output_tokens: 42 } }, 42],
  ] as const)('extracts %s without spawning a CLI', async (_name, adapter, event, tokens) => {
    const run = vi.spyOn(processRunner, 'runProcess').mockResolvedValue({ stdout: JSON.stringify(event), stderr: '',
      exitCode: 0, durationMs: 1, timedOut: false, aborted: false });
    try {
      const result = await adapter.run({ prompt: 'test', systemPrompt: 'test', cwd: process.cwd(), mode: 'readonly',
        model: adapter.defaultModel, timeoutMs: 1000, signal: new AbortController().signal });
      expect(result.usage?.reasoningTokens).toBe(tokens);
    } finally {
      run.mockRestore();
    }
  });
});

describe('task state machine', () => {
  test('allows the documented lifecycle', () => {
    expect(canTransition('pending', 'ready')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('failed', 'ready')).toBe(true);
    expect(canTransition('failed', 'pending')).toBe(true); // re-queued behind a fix task
    expect(canTransition('ready', 'waiting_approval')).toBe(true);
  });
  test('rejects illegal transitions', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(/Illegal/);
    expect(() => assertTransition('pending', 'running')).toThrow(/Illegal/);
  });
});

describe('task graph validation', () => {
  test('accepts a DAG', () => {
    expect(validateGraph([{ key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a'] }])).toBeNull();
  });
  test('detects cycles, unknown and duplicate keys', () => {
    expect(validateGraph([{ key: 'a', dependsOn: ['b'] }, { key: 'b', dependsOn: ['a'] }])).toMatch(/cycle/);
    expect(validateGraph([{ key: 'a', dependsOn: ['x'] }])).toMatch(/unknown/);
    expect(validateGraph([{ key: 'a', dependsOn: [] }, { key: 'a', dependsOn: [] }])).toMatch(/duplicate/);
  });
});

describe('agent output parsing', () => {
  test('extracts JSON from fenced model output', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nDone')).toEqual({ a: 1 });
  });
  test('validates plans', () => {
    const plan = parsePlan('{"tasks":[{"key":"api","title":"API","role":"backend","dependsOn":[]}]}');
    expect(plan.tasks[0].description).toBe('');
    expect(() => parsePlan('{"tasks":[{"key":"Bad Key","title":"x","role":"backend"}]}')).toThrow(/kebab-case/);
    expect(() => parsePlan('{"tasks":[{"key":"a","title":"x","role":"devops"}]}')).toThrow(/Invalid plan/);
  });
  test('reads review verdicts', () => {
    expect(parseVerdict('ok\nVERDICT: PASS')).toBe('pass');
    expect(parseVerdict('**VERDICT: FAIL**')).toBe('fail');
    expect(parseVerdict('no verdict')).toBeNull();
  });
  test('uses the last review verdict', () => {
    expect(parseVerdict('VERDICT: PASS ... VERDICT: FAIL')).toBe('fail');
  });
});

describe('secret redaction', () => {
  test('masks common token formats and registered secrets', () => {
    registerSecret('super-secret-value-123');
    const text = redact('key sk-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz12 api_key=hunter2hunter and super-secret-value-123');
    expect(text).not.toMatch(/sk-abcdef|ghp_abc|hunter2hunter|super-secret-value-123/);
    expect(text).toContain('[REDACTED]');
  });
});

describe('command allowlist', () => {
  test('accepts known test commands only', () => {
    expect(isAllowedCommand('npm test')).toBe(true);
    expect(isAllowedCommand('  npm   test ')).toBe(true);
    expect(isAllowedCommand('npm test && rm -rf /')).toBe(false);
    expect(isAllowedCommand('rm -rf .')).toBe(false);
    expect(() => parseCommand('npm test; curl evil')).toThrow(/forbidden token/);
  });
  test('summarises node:test output', () => {
    expect(summarizeTestOutput('ℹ tests 3\nℹ pass 2\nℹ fail 1')).toBe('2 passed, 1 failed');
  });

  test('reports a failing workspace even when another workspace passed first', () => {
    const out = '      Tests  11 passed (11)\n FAIL  test/A.test.tsx > A > b\nError: Unable to find X\n      Tests  1 failed | 103 passed (104)\nnpm error workspace @x/web@0.1.0';
    expect(summarizeTestOutput(out)).toBe('1 failed | 103 passed (104); 11 passed (11)');
    expect(failureDigest(out)).toContain('test/A.test.tsx > A > b');
    expect(failureDigest(out)).toContain('Unable to find X');
  });

  test('routes frontend-only test failures to the Frontend agent', () => {
    expect(fixRoleFor('tests', 'FAIL  test/AgentsPage.test.tsx > x\nnpm error workspace @fabm/web@0.1.0')).toBe('frontend');
    expect(fixRoleFor('tests', 'FAIL  test/api.test.ts > x\nnpm error workspace @fabm/server@0.1.0')).toBe('backend');
    expect(fixRoleFor('tests', 'some crash')).toBe('backend');
    expect(fixRoleFor('review', 'FAIL  web/a.tsx')).toBe('backend');
  });
});

describe('commitAll', () => {
  test('never commits Antigravity scratch task files', async () => {
    const dir = tempDir('commit');
    await git(dir, ['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(dir, '.asf-agy-task-abc.md'), 'prompt');
    expect(await commitAll(dir, 'only scratch')).toBeNull();
    fs.writeFileSync(path.join(dir, 'real.txt'), 'x');
    expect(await commitAll(dir, 'real change')).not.toBeNull();
    expect(await git(dir, ['ls-files'])).toBe('real.txt');
  });
});

describe('git guard', () => {
  test('refuses destructive subcommands', async () => {
    await expect(git(process.cwd(), ['push', 'origin', 'main'])).rejects.toThrow(/not permitted/);
    await expect(git(process.cwd(), ['reset', '--hard'])).rejects.toThrow(/not permitted/);
    await expect(git(process.cwd(), ['merge', 'some-branch'])).rejects.toThrow(/--no-ff/);
  });
});

describe('workspace path guard', () => {
  const dataDir = tempDir('guard');
  const config = loadConfig({ dataDir, workspacesDir: path.join(dataDir, 'ws'), worktreesDir: path.join(dataDir, 'wt'), approvedRoots: [] });
  fs.mkdirSync(config.workspacesDir, { recursive: true });
  const manager = new WorkspaceManager(config);
  const root = path.join(config.workspacesDir, 'p');
  fs.mkdirSync(root, { recursive: true });

  test('rejects traversal, absolute paths and .git writes', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/Windows/x', '.git/config', 'a//b', '']) {
      expect(() => manager.resolveInside(root, bad), bad).toThrow();
    }
    expect(manager.resolveInside(root, 'src/app.ts')).toBe(path.join(fs.realpathSync.native(root), 'src', 'app.ts'));
  });

  test('only approved roots can be imported', async () => {
    await expect(manager.validateImport(process.cwd())).rejects.toThrow(/outside the approved/);
  });

  test('writes edits inside the workspace', () => {
    expect(manager.applyEdits(root, [{ path: 'src/a.txt', content: 'hi' }])).toEqual(['src/a.txt']);
    expect(fs.readFileSync(path.join(root, 'src', 'a.txt'), 'utf8')).toBe('hi');
  });
});

describe('configuration', () => {
  test('refuses a remote bind without an auth token', () => {
    const previous = process.env.ASF_HOST;
    process.env.ASF_HOST = '0.0.0.0';
    try {
      expect(() => loadConfig({ dataDir: tempDir('cfg'), authToken: null })).toThrow(/ASF_AUTH_TOKEN/);
    } finally {
      if (previous === undefined) delete process.env.ASF_HOST; else process.env.ASF_HOST = previous;
    }
  });
});

describe('provider usage limits', () => {
  test('recognises limit messages and parses the reset time', async () => {
    const { looksLikeLimit, parseResetTime } = await import('../src/providers/types.ts');
    expect(looksLikeLimit("You've hit your session limit · resets 9:20pm (Asia/Tashkent)")).toBe(true);
    expect(looksLikeLimit('429 Too Many Requests')).toBe(true);
    expect(looksLikeLimit('SyntaxError in app.ts')).toBe(false);
    const now = new Date(2026, 9, 15, 18, 0);
    const reset = parseResetTime('resets 9:20pm', now);
    expect([reset.getHours(), reset.getMinutes(), reset.getDate()]).toEqual([21, 20, 15]);
    expect(parseResetTime('resets 9:20am', now).getDate()).toBe(16); // already past today -> tomorrow
  });
});

describe('commitAll keeps caches out', () => {
  test('never commits node_modules or npm caches even without a .gitignore', async () => {
    const dir = tempDir('cache');
    await git(dir, ['init', '-q', '-b', 'main']);
    for (const p of ['node_modules/x/index.js', '.npm-cache/_cacache/a', 'web/node_modules/y.js', 'src/app.js']) {
      fs.mkdirSync(path.join(dir, path.dirname(p)), { recursive: true });
      fs.writeFileSync(path.join(dir, p), 'x');
    }
    expect(await commitAll(dir, 'code')).not.toBeNull();
    expect(await git(dir, ['ls-files'])).toBe('src/app.js');
  });
});
