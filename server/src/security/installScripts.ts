import type { StudioContext } from '../orchestrator/context.ts';

/**
 * Package lifecycle scripts (preinstall/install/postinstall of every dependency) run with the owner's file access. The
 * studio runs `npm/pnpm/yarn install` with `--ignore-scripts` unless the owner allowed scripts for that project (P7-S8).
 */
const settingKey = (projectId: string): string => `project:installScripts:${projectId}`;

export function installScriptsAllowed(ctx: StudioContext, projectId: string): boolean {
  return ctx.repos.config.getSetting<boolean>(settingKey(projectId), false) === true;
}

export function setInstallScriptsAllowed(ctx: StudioContext, projectId: string, allowed: boolean): void {
  ctx.repos.config.setSetting(settingKey(projectId), allowed);
  ctx.events.emit({ projectId, type: 'audit.install_scripts', level: 'warn',
    message: allowed ? 'Package install scripts allowed for this project by the owner'
      : 'Package install scripts blocked again (installs run with --ignore-scripts)', data: { allowed } });
}

const INSTALLS: readonly string[][] = [['npm', 'ci'], ['npm', 'install'], ['npm', 'i'], ['pnpm', 'install'], ['pnpm', 'i'], ['yarn', 'install']];

/** `C:\\Program Files\\nodejs\\npm.cmd` → `npm`. */
const tool = (exe: string | undefined): string => (exe ?? '').toLowerCase().split(/[\\/]/).at(-1)!.replace(/\.(cmd|exe|ps1)$/, '');

/** Explicit script runs (`npm test`, `npm run x`) keep their own script; their pre/post hooks would be skipped by the env. */
const SCRIPT_RUNNERS = new Set(['test', 't', 'run', 'run-script', 'rum', 'urn', 'start', 'stop', 'restart']);

/** A flag that would switch scripts back on (`--ignore-scripts=false`, `--no-ignore-scripts`): refused while blocked (V21-S3). */
export function scriptOverrideFlag(argv: string[]): string | null {
  return argv.find((token) => /^--(no-)?ignore-scripts=(false|0|no)$/i.test(token) || /^--no-ignore-scripts$/i.test(token)) ?? null;
}

/**
 * Environment that keeps npm/pnpm/yarn (and `npx`'s implicit installs) from running lifecycle scripts while they are
 * blocked, whatever the argv spelling — npm reads `npm_config_ignore_scripts`, yarn 1 `YARN_IGNORE_SCRIPTS` (V21-S3).
 */
export function installScriptsEnv(argv: string[], allowScripts: boolean): Record<string, string> {
  if (allowScripts) return {};
  const exe = tool(argv[0]);
  if (['npm', 'pnpm', 'yarn'].includes(exe) && SCRIPT_RUNNERS.has(argv[1] ?? '')) return {};
  return { npm_config_ignore_scripts: 'true', YARN_IGNORE_SCRIPTS: 'true' };
}

/** argv with `--ignore-scripts` added to a package install, unless scripts are allowed or it is already there. */
export function guardInstallScripts(argv: string[], allowScripts: boolean): string[] {
  if (allowScripts || argv.includes('--ignore-scripts')) return argv;
  const exe = tool(argv[0]);
  const isInstall = INSTALLS.some(([manager, sub]) => exe === manager && argv[1] === sub);
  return isInstall ? [...argv, '--ignore-scripts'] : argv;
}
