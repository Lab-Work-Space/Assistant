import { createApp } from './app.js';
import { loadEnv, redactText } from './core/index.js';
import { startReleaseWatch } from './core/release-watch.js';

const fail = (what: string, err: unknown) => console.error(redactText(`${what}: ${err instanceof Error ? err.message : String(err)}`));

/** Process entry: boot, then a graceful stop on SIGTERM/SIGINT (not a halt; doing tasks are recovered on the next boot). */
async function main(): Promise<void> {
  const env = loadEnv();
  const booting = createApp(env);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    // Also safe during boot: waits for createApp, and app.stop() waits for a running start() before tearing down.
    booting.then((app) => app.stop()).then(
      () => process.exit(0),
      (err: unknown) => {
        fail(`shutdown after ${signal} failed`, err);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  // Self-code (OD-2a): running from a release directory, a switch of `current` by the executor is a request for a graceful restart.
  startReleaseWatch({ onChange: () => shutdown('release switch') });
  const app = await booting;
  if (stopping) return;
  await app.start();
}

main().catch((err: unknown) => {
  // loadEnv errors never include values; anything else is masked by pattern before it reaches the console.
  fail('boot failed', err);
  process.exit(1);
});
