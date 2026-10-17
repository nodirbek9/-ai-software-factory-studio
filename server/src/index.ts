import { createStudio } from './app.ts';
import { StudioAlreadyRunningError } from './instanceLock.ts';
import { createLifecycleLog } from './lifecycleLog.ts';
import { STUDIO_VERSION } from './version.ts';

let studio: Awaited<ReturnType<typeof createStudio>>;
try {
  // Recovery is deferred: a second copy must fail on the lock or the port before it touches any task state.
  studio = await createStudio({}, { logger: true, deferRecovery: true });
} catch (error) {
  console.error(error instanceof StudioAlreadyRunningError ? error.message : error);
  process.exit(1);
}
const { host, port, dataDir } = studio.ctx.config;
const lifecycle = createLifecycleLog(dataDir);

try {
  await studio.app.listen({ host, port });
  studio.app.log.info(`AI Software Factory Studio listening on http://${host}:${port}`);
  lifecycle(`started v${STUDIO_VERSION} on http://${host}:${port}`);
} catch (error) {
  studio.app.log.error(error);
  lifecycle(`could not listen on ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`);
  await studio.close().catch(() => undefined);
  process.exit(1);
}
await studio.start();

let closing = false;
const shutdown = async (reason: string): Promise<void> => {
  if (closing) return;
  closing = true;
  lifecycle(`stopping: ${reason}`);
  studio.app.log.info(`${reason} — stopping scheduler and closing`);
  await studio.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT received (Ctrl+C)'));
process.on('SIGTERM', () => void shutdown('SIGTERM received'));
// Windows: closing the console window sends SIGHUP, Ctrl+Break sends SIGBREAK.
process.on('SIGHUP', () => void shutdown('SIGHUP received (the console window was closed)'));
process.on('SIGBREAK', () => void shutdown('SIGBREAK received (Ctrl+Break)'));
process.on('uncaughtException', (error) => {
  lifecycle(`crashed: uncaught exception: ${error.stack ?? error.message}`);
  studio.app.log.error(error);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  lifecycle(`crashed: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  studio.app.log.error(reason);
  process.exit(1);
});
process.on('exit', (code) => lifecycle(`exited with code ${code}`));
