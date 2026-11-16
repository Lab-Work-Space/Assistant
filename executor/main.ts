import { Events } from 'discord.js';
import { createLogger, redactText } from '../core/index.js';
import { createPool } from '../db/pool.js';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { DeployRepo } from '../db/repos/deploy.js';
import { ExecRepo } from '../db/repos/exec.js';
import { AuditRepo } from '../db/repos/ledger.js';
import { createAudit } from '../governance/audit.js';
import { createDiscordPermWriter } from '../discord/perm/perm-apply.js';
import { permConsts } from '../discord/perm/perm-limits.js';
import { ARCHIVE_CATEGORY_NAME, type ServerConsts } from '../discord/server/server-limits.js';
import { createServerWriter } from '../discord/server/server-apply.js';
import { BOT_LOG_CHANNEL_ID } from '../company/channels.js';
import { VpsClient } from '../vps/ssh.js';
import { join } from 'node:path';
import { DevJobRepo } from '../db/repos/devjobs.js';
import { realGit } from '../devjob/git.js';
import { makeSupplyPort, type FetchLike } from '../devjob/supply-net.js';
import { AdminClient } from './admin-client.js';
import { CodeApplier, type HealthBody } from './code-apply.js';
import { realBuildPorts } from './code-run.js';
import { CodeService } from './code-service.js';
import { trustProblem } from './code-trust.js';
import { SecondConfirm } from './confirm.js';
import { attachConfirmListener, discordConfirmPort, type ConfirmClient } from './confirm-discord.js';
import { DeployService } from './deploy.js';
import { loadExecutorEnv } from './env.js';
import { ipcHandler } from './handler.js';
import { startIpcServer } from './ipc.js';
import { createRateGate } from './rate.js';
import { ExecutorService } from './service.js';
import { readTierConfig } from './tiers.js';
import { createWelcome, readWelcomeConfig } from './welcome.js';
import { createServerWorld } from './world.js';

/**
 * The executor process ("LW Admin", Gate 1 S2 option A). It holds BOT_TOKEN_ADMIN and nothing else secret, serves the local IPC socket,
 * handles GuildMemberAdd for the welcome flow and applies confirmed cards. It never answers a message or an interaction.
 */
const PURGE_EVERY_MS = 6 * 3600_000;

async function main(): Promise<void> {
  const env = loadExecutorEnv();
  const secrets = [env.token, env.databaseUrl];
  const log = createLogger(env.logLevel, { secrets });
  const pool = createPool(env.databaseUrl, 4);
  // The main application owns the migrations; wait for the executor's columns and tables instead of racing it.
  for (let i = 0; ; i++) {
    const ok = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'admin_cards' AND column_name = 'executed_at' AND table_schema = current_schema()`).then((r) => (r.rowCount ?? 0) > 0, () => false);
    if (ok) break;
    if (i >= 40) throw new Error('the database is not migrated (start the main application first)');
    await new Promise((r) => setTimeout(r, 3000));
  }
  const exec = new ExecRepo(pool);
  const audit = createAudit(new AuditRepo(pool), log);
  const admin = new AdminClient({ guildId: env.guildId, log });
  const started = await admin.start(env.token);
  if (!started.ok) log.error({ problems: started.problems }, 'executor is OFF (it keeps serving status)');
  const client = () => admin.get();
  const world = createServerWorld({ client, guildId: env.guildId, pool });
  // Gate 1 V22: VPS deploy is on only when the executor's own env names a deploy key; the key is checked (mode, owner, pin) on every call.
  const deployRepo = new DeployRepo(pool);
  const deploy = env.deployKeyPath ? new DeployService({ client: new VpsClient({ keyPath: env.deployKeyPath }), repo: deployRepo, exec, audit, log, secrets }) : undefined;
  // Self-code (OD-2a): code changes are on only when the executor's own env names a release root, the pinned compiler and package manager and the health url.
  let code: CodeService | undefined;
  if (env.codeRoot && env.tscPath && env.npmPath && env.healthUrl) {
    const git = realGit(join(env.codeRoot, 'repo.git'));
    const healthUrl = env.healthUrl;
    const health = async (): Promise<HealthBody | null> => {
      try { return (await (await fetch(healthUrl, { signal: AbortSignal.timeout(5000) })).json()) as HealthBody; } catch { return null; }
    };
    const applier = new CodeApplier({ git, root: env.codeRoot, build: realBuildPorts({ tscPath: env.tscPath, npmPath: env.npmPath }), restart: async () => undefined, health, audit });
    // G2SC-02: ownership of the code root, repo.git and the tools is checked now and again before every check and apply.
    const codeRoot = env.codeRoot;
    const trust = () => trustProblem({ root: codeRoot, tsc: env.tscPath!, npm: env.npmPath! });
    const bad = trust();
    if (bad) log.error({ problem: bad }, 'code changes are refused until the code root is fixed');
    code = new CodeService({ trust, jobs: new DevJobRepo(pool), git, bundleDir: join(env.codeRoot, 'bundles'), applier, supply: makeSupplyPort(fetch as unknown as FetchLike), ownerUserId: env.ownerUserId, exec, audit, log });
  }
  // OD-G2-1: the second confirmation goes out and comes back through LW Admin's OWN client; the main application cannot produce it.
  const confirm = new SecondConfirm({ port: discordConfirmPort(() => client() as unknown as ConfirmClient | undefined), audit, log });
  const consts = (): ServerConsts => ({ ...permConsts(env.botAdminRoleId, 0), botLogChannelId: BOT_LOG_CHANNEL_ID, archiveCategoryName: ARCHIVE_CATEGORY_NAME });
  const service = new ExecutorService({
    world, permWriter: createDiscordPermWriter({ client, guildId: env.guildId }), serverWriter: createServerWriter({ client, guildId: env.guildId }),
    cards: new AdminCardRepo(pool), exec, rate: createRateGate(pool), consts, recheck: () => admin.recheck(), disabled: () => admin.isBarred(),
    welcomeRoleIds: async () => (await readWelcomeConfig(pool)).roleIds, tiers: () => readTierConfig(pool), audit, log, secrets,
    ...(deploy ? { deploy } : {}), ...(code ? { code } : {}), ownerUserId: env.ownerUserId, confirm,
  });
  if (started.ok && client()) {
    attachConfirmListener(client() as unknown as ConfirmClient, confirm, log);
    const welcome = createWelcome({ exec, world, writer: createServerWriter({ client, guildId: env.guildId }), consts, cfg: () => readWelcomeConfig(pool), audit, log });
    client()!.on(Events.GuildMemberAdd, (m) => {
      if (m.guild.id === env.guildId) void welcome.onJoin({ id: m.id, isBot: m.user.bot });
    });
  }
  const server = await startIpcServer(env.socketPath, ipcHandler(service, () => started.userId), log, { shared: env.socketShared });
  const purge = setInterval(() => void Promise.all([exec.purge(), deployRepo.purge()]).catch((err: unknown) => log.error({ err: redactText(err instanceof Error ? err.message : 'error') }, 'audit purge failed')), PURGE_EVERY_MS);
  purge.unref();
  if (deploy) log.info({ resumed: await deploy.resume().catch(() => 0) }, 'deploy is on');
  log.info({ socket: env.socketPath, on: started.ok, deploy: !!deploy, code: !!code }, 'executor ready');
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearInterval(purge);
    server.close();
    void admin.stop().then(() => pool.end()).then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(redactText(`executor boot failed: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});

