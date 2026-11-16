import { pathToFileURL } from 'node:url';
import { Client, GatewayIntentBits } from 'discord.js';
import { allowedGuildBits } from '../discord/perm/permissions.js';
import { bitNames, labelOf } from '../discord/perm/perm-bits.js';
import { loadEnv } from '../core/env.js';

/**
 * Gate 1 C19 Step 0, owner-run and read-only: logs each configured bot in (Guilds intent only), reads its guild-wide permission bits and prints,
 * per bot, the bits outside the allowlist the boot check would apply. Prints bit names and numbers only, never a token.
 * Run it with the same environment as the app: `node dist/scripts/dump-bot-permissions.js`. A bit it reports from @everyone is fixed in the
 * Discord server settings; the allowlist in discord/perm/perm-bits.ts is widened only by an owner decision.
 */
async function dumpOne(who: string, token: string, guildId: string): Promise<boolean> {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    await client.login(token);
    const guild = await client.guilds.fetch(guildId);
    const me = await guild.members.fetchMe({ force: true });
    const bits = me.permissions.bitfield;
    const extra = bits & ~allowedGuildBits(who);
    const roles = me.roles.cache.map((r) => `${r.managed ? 'managed ' : ''}${r.id}`).join(', ');
    console.log(`${who}: bits=${bits} roles=[${roles}] ${extra === 0n ? 'OK' : `OUTSIDE ALLOWLIST: ${bitNames(extra).map(labelOf).join(', ')}`}`);
    return extra === 0n;
  } catch (e) {
    console.log(`${who}: could not read (${e instanceof Error ? e.name : 'error'})`);
    return false;
  } finally {
    await client.destroy();
  }
}

/**
 * `--admin` (Gate 1 S37): the separate executor. Run it with the executor's own environment, never the app's:
 * `node --env-file=$HOME/.config/assistant/env.admin dist/scripts/dump-bot-permissions.js --admin`. Expected: `admin: ... OK`.
 */
export async function mainAdmin(src: NodeJS.ProcessEnv = process.env): Promise<number> {
  const token = src.BOT_TOKEN_ADMIN?.trim();
  if (!token) {
    console.log('admin: no BOT_TOKEN_ADMIN in this environment (use --env-file=~/.config/assistant/env.admin)');
    return 1;
  }
  return (await dumpOne('admin', token, src.GUILD_ID?.trim() || '1565649426943442944')) ? 0 : 1;
}

export async function main(env = loadEnv()): Promise<number> {
  let unsafe = 0;
  for (const [dept, token] of Object.entries(env.botTokens)) {
    if (!token) continue;
    if (!(await dumpOne(dept, token, env.guildId))) unsafe++;
  }
  return unsafe;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (process.argv.includes('--admin') ? mainAdmin() : main()).then((n) => process.exit(n === 0 ? 0 : 1), () => process.exit(2));
}
