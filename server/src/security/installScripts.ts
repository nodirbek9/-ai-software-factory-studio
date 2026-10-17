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

/** argv with `--ignore-scripts` added to a package install, unless scripts are allowed or it is already there. */
export function guardInstallScripts(argv: string[], allowScripts: boolean): string[] {
  if (allowScripts || argv.includes('--ignore-scripts')) return argv;
  const exe = argv[0]?.toLowerCase().replace(/\.cmd$/, '');
  const isInstall = INSTALLS.some(([tool, sub]) => exe === tool && argv[1] === sub);
  return isInstall ? [...argv, '--ignore-scripts'] : argv;
}
