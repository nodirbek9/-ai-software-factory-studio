import { describe, expect, it } from 'vitest';
import { guardInstallScripts, installScriptsAllowed } from '../src/security/installScripts.ts';
import { startStudio, tempDir } from './helpers.ts';

describe('package install scripts (P7-S8)', () => {
  it('adds --ignore-scripts to package installs unless scripts are allowed', () => {
    expect(guardInstallScripts(['npm', 'install'], false)).toEqual(['npm', 'install', '--ignore-scripts']);
    expect(guardInstallScripts(['npm', 'ci'], false)).toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(guardInstallScripts(['npm.cmd', 'i', 'left-pad'], false)).toEqual(['npm.cmd', 'i', 'left-pad', '--ignore-scripts']);
    expect(guardInstallScripts(['pnpm', 'install'], false)).toEqual(['pnpm', 'install', '--ignore-scripts']);
    expect(guardInstallScripts(['yarn', 'install'], false)).toEqual(['yarn', 'install', '--ignore-scripts']);
    expect(guardInstallScripts(['npm', 'ci', '--ignore-scripts'], false)).toEqual(['npm', 'ci', '--ignore-scripts']);
    expect(guardInstallScripts(['npm', 'install'], true)).toEqual(['npm', 'install']);
    expect(guardInstallScripts(['npm', 'test'], false)).toEqual(['npm', 'test']);
    expect(guardInstallScripts(['npm', 'run', 'build'], false)).toEqual(['npm', 'run', 'build']);
  });

  it('is off by default and only the owner can switch it, with confirm and an audit event', async () => {
    const studio = await startStudio(tempDir('install-scripts'), tempDir('samples'));
    try {
      const project = await studio.projects.create({ name: 'Scripts', spec: 'spec', workspaceMode: 'new' });
      const url = `/api/v2/projects/${project.id}/install-scripts`;
      expect((await studio.app.inject({ url })).json()).toEqual({ allowed: false });

      const unconfirmed = await studio.app.inject({ method: 'PUT', url, payload: { allowed: true } });
      expect(unconfirmed.statusCode).toBe(400);
      expect(installScriptsAllowed(studio.ctx, project.id)).toBe(false);

      const allowed = await studio.app.inject({ method: 'PUT', url, payload: { allowed: true, confirm: true } });
      expect(allowed.json()).toEqual({ allowed: true });
      expect(installScriptsAllowed(studio.ctx, project.id)).toBe(true);
      expect(studio.ctx.repos.events.list({ projectId: project.id, limit: 20 }).some((e) => e.type === 'audit.install_scripts')).toBe(true);

      const missing = await studio.app.inject({ url: '/api/v2/projects/00000000-0000-4000-8000-000000000000/install-scripts' });
      expect(missing.statusCode).toBe(404);
    } finally {
      await studio.close();
    }
  });
});

describe('install-scripts bypasses (V21-S3)', () => {
  it('blocks scripts through the environment for every package-manager use except explicit script runs', async () => {
    const { installScriptsEnv, scriptOverrideFlag } = await import('../src/security/installScripts.ts');
    const blocked = { npm_config_ignore_scripts: 'true', YARN_IGNORE_SCRIPTS: 'true' };
    expect(installScriptsEnv(['npx', 'vitest', 'run'], false)).toEqual(blocked);
    expect(installScriptsEnv(['C:/nodejs/npm.cmd', 'install', '--prefer-offline'], false)).toEqual(blocked);
    expect(installScriptsEnv(['C:/nodejs/npm.cmd', 'test'], false)).toEqual({}); // the path is reduced to the tool name
    expect(installScriptsEnv(['npm', 'test'], false)).toEqual({});
    expect(installScriptsEnv(['npm', 'run', 'build'], false)).toEqual({});
    expect(installScriptsEnv(['npx', 'vitest', 'run'], true)).toEqual({});
    expect(scriptOverrideFlag(['npm', 'ci', '--ignore-scripts', '--ignore-scripts=false'])).toBe('--ignore-scripts=false');
    expect(scriptOverrideFlag(['npm', 'install', '--no-ignore-scripts'])).toBe('--no-ignore-scripts');
    expect(scriptOverrideFlag(['npm', 'ci', '--ignore-scripts'])).toBeNull();
  });

  it('refuses an approved command that switches scripts back on', async () => {
    const { runAllowedCommand, CommandNotAllowedError } = await import('../src/workspace/commandRunner.ts');
    await expect(runAllowedCommand('npm install --ignore-scripts=false', tempDir('override'), { timeoutMs: 5_000, approved: true }))
      .rejects.toBeInstanceOf(CommandNotAllowedError);
  });
});
