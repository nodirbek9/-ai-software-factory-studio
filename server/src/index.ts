import { createStudio } from './app.ts';
import { StudioAlreadyRunningError } from './instanceLock.ts';

let studio: Awaited<ReturnType<typeof createStudio>>;
try {
  // Recovery is deferred: a second copy must fail on the lock or the port before it touches any task state.
  studio = await createStudio({}, { logger: true, deferRecovery: true });
} catch (error) {
  console.error(error instanceof StudioAlreadyRunningError ? error.message : error);
  process.exit(1);
}
const { host, port } = studio.ctx.config;

try {
  await studio.app.listen({ host, port });
  studio.app.log.info(`AI Software Factory Studio listening on http://${host}:${port}`);
} catch (error) {
  studio.app.log.error(error);
  await studio.close().catch(() => undefined);
  process.exit(1);
}
await studio.start();

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  studio.app.log.info(`${signal} received — stopping scheduler and closing`);
  await studio.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
