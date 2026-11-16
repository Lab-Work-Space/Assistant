import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { PermOp, PermProposal } from './perm-ops.js';
import { SAFE_BITS } from './perm-bits.js';
import { checkPermOps, constantsProblem, permsProblem } from './perm-limits.js';
import { C, F, R, U, consts, fakeWorld, worldData } from '../test-helpers.js';

const op = (o: unknown): PermOp => PermOp.parse(o);
const run = async (o: unknown, w = fakeWorld(), c = consts()) => checkPermOps([op(o)], w, c);
const refused = async (o: unknown, why: RegExp, w = fakeWorld(), c = consts()) => {
  const r = await run(o, w, c);
  expect(r.ok, JSON.stringify(o)).toBe(false);
  if (!r.ok) expect(r.error).toMatch(why);
};
const allowed = async (o: unknown, w = fakeWorld()) => {
  const r = await run(o, w);
  expect(r.ok, JSON.stringify(o) + (r.ok ? '' : r.error)).toBe(true);
  return r.ok ? r.resolved : [];
};
const ow = (channel: string, target: { type: 'role' | 'member'; id: string }, allow = 0n, deny = 0n) => ({ kind: 'overwrite.set', channel, target, allow: String(allow), deny: String(deny) });

describe('bit strings (C15)', () => {
  it('refuses negative, non-integer, hex and over-64-bit values at parse time', () => {
    for (const bad of ['-1', '1.5', '0x10', '', '18446744073709551616', 'abc', ' 1']) {
      expect(() => op({ ...ow(C.general, { type: 'role', id: R.staff }), allow: bad })).toThrow();
    }
    expect(() => op({ ...ow(C.general, { type: 'role', id: R.staff }), allow: 1 })).toThrow();
  });

  it('every PermissionFlagsBits member outside the safe set is refused as an allow bit, in an overwrite and in role.create / role.edit', async () => {
    const safe = new Set(SAFE_BITS);
    const unsafe = Object.entries(PermissionFlagsBits).filter(([, b]) => !safe.has(b));
    expect(unsafe.length).toBeGreaterThan(30);
    for (const [name, bit] of unsafe) {
      await refused(ow(C.general, { type: 'role', id: R.staff }, bit), /outside the safe set/);
      await refused({ kind: 'role.create', name: 'Newbie', color: 0, hoist: false, permissions: String(bit) }, /outside the safe set/);
      await refused({ kind: 'role.edit.permissions', role: R.staff, permissions: String(bit) }, /outside the safe set/);
      void name;
    }
    await refused(ow(C.general, { type: 'role', id: R.staff }, 1n << 60n), /outside the safe set/); // a bit discord.js does not know
    await refused(ow(C.general, { type: 'role', id: R.staff }, (1n << 64n) - 1n), /outside the safe set/);
  });

  it('every safe bit is accepted as an allow bit', async () => {
    for (const bit of SAFE_BITS) await allowed(ow(C.general, { type: 'role', id: R.extra }, bit));
  });

  it('deny may name any defined bit but not an undefined one, and allow+deny of the same bit is nonsense', async () => {
    await allowed(ow(C.general, { type: 'role', id: R.extra }, 0n, F.Administrator | F.SendMessages));
    await refused(ow(C.general, { type: 'role', id: R.extra }, 0n, 1n << 62n), /does not define/);
    await refused(ow(C.general, { type: 'role', id: R.extra }, F.ViewChannel, F.ViewChannel), /both allowed and denied/);
  });
});

describe('locked channels (C17)', () => {
  it('a denied channel, a denied category, a channel inside one and a thread are refused for every channel-touching op', async () => {
    for (const ch of ['1565715069969502310', '1565649677280485457', C.deniedCat, C.inDeniedCat]) {
      await refused(ow(ch, { type: 'role', id: R.extra }, F.ViewChannel), /off limits|protected category/);
      await refused({ kind: 'overwrite.clear', channel: ch, target: { type: 'role', id: R.extra } }, /off limits|protected category/);
    }
    await refused({ kind: 'channel.create', name: 'new', category: C.deniedCat, type: 'text', sync: true }, /off limits/);
    await refused({ kind: 'channel.create', name: 'new', category: '1565715069969502310', type: 'text', sync: false }, /off limits/);
    await refused(ow(C.thread, { type: 'role', id: R.extra }, F.ViewChannel), /thread/);
  });

  it('a channel or category that cannot be read, or whose parent cannot be read, is refused', async () => {
    await refused(ow(C.unreadable, { type: 'role', id: R.extra }, F.ViewChannel), /could not be read/);
    await refused(ow(C.orphan, { type: 'role', id: R.extra }, F.ViewChannel), /category .* could not be read/);
    await refused({ kind: 'channel.create', name: 'new', category: C.unreadable, type: 'text', sync: false }, /could not be read/);
  });

  it('channel.create needs a real category', async () => {
    await refused({ kind: 'channel.create', name: 'new', category: C.general, type: 'text', sync: false }, /not a category/);
    await allowed({ kind: 'channel.create', name: 'new-room', category: C.cat, type: 'voice', sync: true });
    await allowed({ kind: 'channel.create', name: 'top', category: null, type: 'forum', sync: false });
  });

  it('channel names are plain text: mentions, markup and hidden characters are refused', async () => {
    for (const name of ['<#1>', '@everyone', 'a‮b', 'x\ny', '# big', '']) {
      const r = PermOp.safeParse({ kind: 'channel.create', name, category: null, type: 'text', sync: false });
      if (r.success) await refused(r.data, /channel name/);
    }
  });
});

describe('untouchable roles and members (C16, C17)', () => {
  it('Founder, Bot Admin, other privileged roles, @everyone, managed roles, roles at or above Praw, roles bots hold and Praw\'s own role are refused for assign, remove and edit', async () => {
    for (const role of [R.founder, R.botAdmin, R.mod, R.everyone, R.managedOther, R.high, R.botRole, R.prawTop]) {
      await refused({ kind: 'role.assign', member: U.alice, role }, /./);
      await refused({ kind: 'role.edit.permissions', role, permissions: '1024' }, /./);
    }
    await refused({ kind: 'role.remove', member: U.bob, role: R.founder }, /Founder|privileged/);
    await refused({ kind: 'role.assign', member: U.alice, role: '700000000000099999' }, /not found/);
  });

  it('a role that carries powers beyond the safe set cannot be handed out; a normal role can', async () => {
    await refused({ kind: 'role.assign', member: U.alice, role: R.powerful }, /beyond the safe set/);
    const r = await allowed({ kind: 'role.assign', member: U.alice, role: R.staff });
    expect(r[0]!.item.refs).toEqual([{ kind: 'user', id: U.alice }, { kind: 'role', id: R.staff }]);
  });

  it('bots, Praw herself, the owner, holders of Founder or Bot Admin and an unfetchable member are refused as targets', async () => {
    await refused({ kind: 'role.assign', member: U.botSw, role: R.staff }, /bot/);
    await refused({ kind: 'role.assign', member: U.eve, role: R.staff }, /bot/); // a bot nobody knows by id: user.bot is true
    await refused({ kind: 'role.assign', member: U.praw, role: R.staff }, /herself/);
    await refused({ kind: 'role.assign', member: U.owner, role: R.staff }, /owner/);
    await refused({ kind: 'role.assign', member: U.admin, role: R.staff }, /privileged/);
    await refused({ kind: 'role.remove', member: U.founder, role: R.staff }, /privileged/);
    await refused({ kind: 'role.assign', member: '700000000000088888', role: R.staff }, /could not be fetched/);
    await refused(ow(C.general, { type: 'member', id: U.botHq }, F.ViewChannel), /bot/);
    await refused(ow(C.general, { type: 'member', id: U.admin }, F.ViewChannel), /privileged/);
    await refused(ow(C.general, { type: 'member', id: '700000000000088888' }, F.ViewChannel), /could not be fetched/);
  });

  it('overwrite targets: privileged, managed, high and bot-held roles are refused; @everyone and a normal role are fine', async () => {
    for (const role of [R.founder, R.botAdmin, R.mod, R.managedOther, R.high, R.botRole]) await refused(ow(C.general, { type: 'role', id: role }, F.ViewChannel), /./);
    await allowed(ow(C.general, { type: 'role', id: R.everyone }, 0n, F.SendMessages));
    await allowed(ow(C.general, { type: 'role', id: R.extra }, F.ViewChannel | F.SendMessages));
    await allowed(ow(C.general, { type: 'member', id: U.alice }, F.ViewChannel));
  });

  it('when a configured bot is not online its roles cannot be ruled out: every op fails closed', async () => {
    await refused({ kind: 'role.assign', member: U.alice, role: R.staff }, /not every configured bot is online/, fakeWorld(worldData(), { botIds: [U.praw] }));
  });

  it('a role cannot be created under an existing name, and only with safe permissions', async () => {
    await refused({ kind: 'role.create', name: 'bot admin', color: 0, hoist: false, permissions: '0' }, /already exists/);
    const r = await allowed({ kind: 'role.create', name: 'Newcomers', color: 0x336699, hoist: true, permissions: String(F.ViewChannel | F.SendMessages) });
    expect(r[0]!.item.neu).toContain('#336699');
  });
});

describe('system channels (C18)', () => {
  const systems = [C.setting, C.botLog, '1565671253803794494', '1565671325597700157', '1566366032094961705'];
  it('allowing View, Send or Use Application Commands is refused on each, for @everyone, a role and a member', async () => {
    const w = fakeWorld();
    for (const id of systems) w.data.channels.set(id, { id, name: `sys-${id.slice(-4)}`, type: 0, parentId: null, isThread: false, overwrites: [{ id: R.everyone, type: 'role', allow: 0n, deny: F.ViewChannel }] });
    for (const id of systems) {
      for (const bit of [F.ViewChannel, F.SendMessages, F.UseApplicationCommands]) {
        for (const target of [{ type: 'role' as const, id: R.everyone }, { type: 'role' as const, id: R.extra }, { type: 'member' as const, id: U.alice }]) {
          await refused(ow(id, target, bit), /system channel/, w);
        }
      }
      await refused({ kind: 'overwrite.clear', channel: id, target: { type: 'role', id: R.everyone } }, /open a system channel/, w);
      // a deny, or an allow of something harmless, is fine
      await allowed(ow(id, { type: 'role', id: R.extra }, 0n, F.SendMessages), w);
      await allowed(ow(id, { type: 'role', id: R.extra }, F.AddReactions), w);
    }
  });

  it('a deny against Bot Admin or Founder is refused (an admin lockout)', async () => {
    await refused(ow(C.setting, { type: 'role', id: R.botAdmin }, 0n, F.ViewChannel), /./);
    await refused(ow(C.setting, { type: 'role', id: R.founder }, 0n, F.SendMessages), /./);
    await refused(ow(C.setting, { type: 'member', id: U.admin }, 0n, F.ViewChannel), /./);
  });
});

describe('batch and no-ops (C21)', () => {
  it('21 ops are refused at parse time; an empty batch too', () => {
    const one = { kind: 'role.assign', member: U.alice, role: R.staff };
    expect(PermOp.safeParse(one).success).toBe(true);
    expect(PermProposal.safeParse({ ops: Array(21).fill(one) }).success).toBe(false);
    expect(PermProposal.safeParse({ ops: Array(20).fill(one) }).success).toBe(true);
    expect(PermProposal.safeParse({ ops: [] }).success).toBe(false);
  });
  it('the first refused op refuses the whole proposal and names it', async () => {
    const r = await checkPermOps([op({ kind: 'role.assign', member: U.alice, role: R.staff }), op({ kind: 'role.assign', member: U.alice, role: R.founder })], fakeWorld(), consts());
    expect(r).toEqual({ ok: false, error: expect.stringContaining('operation 2 (role.assign) refused') });
  });
  it('no-ops are refused (already holds, no such overwrite)', async () => {
    await refused({ kind: 'role.assign', member: U.bob, role: R.staff }, /already holds/);
    await refused({ kind: 'role.remove', member: U.alice, role: R.staff }, /does not hold/);
    await refused({ kind: 'overwrite.clear', channel: C.general, target: { type: 'role', id: R.extra } }, /no such overwrite/);
  });
  it('the card line names things from live data and the snapshot records the target state', async () => {
    const [r] = await allowed({ kind: 'role.assign', member: U.alice, role: R.staff });
    expect(r!.item.neu).toBe('holds "Staff"');
    expect(r!.snap).toEqual({ held: false });
  });
});

describe('constants and hierarchy (C17, C20)', () => {
  it('empty or half-filled constants keep permission ops off, even though every id check would pass vacuously', async () => {
    expect(constantsProblem(consts({ deniedCategoryIds: [] }))).toMatch(/DENIED_CATEGORY_IDS is empty/);
    expect(constantsProblem(consts({ founderRoleId: '' }))).toMatch(/not filled in/);
    expect(constantsProblem(consts({ privilegedRoleIds: [R.mod] }))).toMatch(/must include FOUNDER/);
    await refused(ow(C.general, { type: 'role', id: R.extra }, F.ViewChannel), /DENIED_CATEGORY_IDS is empty/, fakeWorld(), consts({ deniedCategoryIds: [] }));
    expect(await permsProblem(fakeWorld(), consts({ deniedCategoryIds: [] }))).toMatch(/DENIED_CATEGORY_IDS/);
  });

  it('a sound setup has no problem', async () => {
    expect(await permsProblem(fakeWorld(), consts())).toBeNull();
  });

  it('Bot Admin or Founder below Praw disables permission ops', async () => {
    for (const roleId of [R.botAdmin, R.founder]) {
      const d = worldData();
      d.roles.find((r) => r.id === roleId)!.position = 5;
      expect(await permsProblem(fakeWorld(d), consts())).toMatch(/strictly below/);
    }
  });

  it('Manage Roles on a non-managed role that Praw holds, or that another bot holds, disables permission ops; on a role nobody in the bot set holds it is fine', async () => {
    const d1 = worldData();
    d1.roles.push({ id: R.extra + '1', name: 'Mgr', position: 5, managed: false, botId: null, permissions: F.ManageRoles });
    expect(await permsProblem(fakeWorld(d1), consts())).toBeNull(); // nobody holds it
    d1.members.get(U.praw)!.roleIds.push(R.extra + '1');
    expect(await permsProblem(fakeWorld(d1), consts())).toMatch(/only the executor's own integration role/);
    const d2 = worldData();
    d2.roles.push({ id: R.extra + '2', name: 'Mgr', position: 5, managed: false, botId: null, permissions: F.ManageChannels });
    d2.members.get(U.botHq)!.roleIds.push(R.extra + '2');
    expect(await permsProblem(fakeWorld(d2), consts())).toMatch(/only the executor's own integration role/);
    const d3 = worldData();
    d3.roles.find((r) => r.id === R.everyone)!.permissions |= F.ManageRoles;
    expect(await permsProblem(fakeWorld(d3), consts())).toMatch(/only the executor's own integration role/);
  });

  it('a constant id that is not a real role, a category that cannot be checked, or an offline bot disables permission ops', async () => {
    expect(await permsProblem(fakeWorld(), consts({ privilegedRoleIds: [R.founder, '700000000000077777'] }))).toMatch(/does not exist/);
    expect(await permsProblem(fakeWorld(worldData(), { probe: { [C.deniedCat]: 'error' } }), consts())).toMatch(/could not be checked/);
    expect(await permsProblem(fakeWorld(worldData(), { botIds: [U.praw] }), consts())).toMatch(/not every configured bot/);
  });
});

describe('Gate 2 findings on system channels', () => {
  const systems = [C.setting, C.botLog, '1565671253803794494', '1565671325597700157', '1566366032094961705'];
  const sysWorld = () => {
    const w = fakeWorld();
    for (const id of systems) w.data.channels.set(id, { id, name: `sys-${id.slice(-4)}`, type: 0, parentId: null, isThread: false, overwrites: [
      { id: R.everyone, type: 'role', allow: 0n, deny: F.ViewChannel | F.SendMessages },
      { id: R.extra, type: 'role', allow: 0n, deny: F.ViewChannel },
      { id: R.staff, type: 'role', allow: F.ViewChannel, deny: 0n },
    ] });
    return w;
  };

  it('G2A-01: replacing a widening deny with a neutral or smaller one is refused on every system channel, for @everyone and a plain role', async () => {
    const w = sysWorld();
    for (const id of systems) {
      await refused(ow(id, { type: 'role', id: R.everyone }, 0n, 0n), /remove a deny/, w);
      await refused(ow(id, { type: 'role', id: R.everyone }, 0n, F.SendMessages), /remove a deny/, w);
      await refused(ow(id, { type: 'role', id: R.extra }, 0n, 0n), /remove a deny/, w);
      await refused(ow(id, { type: 'role', id: R.extra }, 0n, F.AddReactions), /remove a deny/, w);
      await allowed(ow(id, { type: 'role', id: R.extra }, 0n, F.ViewChannel | F.AddReactions), w); // keeping the deny is fine
    }
  });

  it('G2A-04: a new widening deny on @everyone is refused (admin lockout), a deny on a plain role is fine', async () => {
    const w = fakeWorld();
    for (const id of systems) w.data.channels.set(id, { id, name: 'sys', type: 0, parentId: null, isThread: false, overwrites: [] });
    for (const id of systems) {
      await refused(ow(id, { type: 'role', id: R.everyone }, 0n, F.ViewChannel), /lock the admins out/, w);
      await allowed(ow(id, { type: 'role', id: R.extra }, 0n, F.ViewChannel), w);
    }
  });

  it('G2A-03: a role allowed into any system channel cannot be assigned; an unreadable system channel refuses', async () => {
    const w = sysWorld();
    for (const id of systems) {
      const w2 = sysWorld();
      for (const other of systems) w2.data.channels.get(other)!.overwrites = other === id ? [{ id: R.staff, type: 'role', allow: F.ViewChannel, deny: 0n }] : [];
      await refused({ kind: 'role.assign', member: U.alice, role: R.staff }, /allowed into a system channel/, w2);
      await allowed({ kind: 'role.assign', member: U.alice, role: R.extra }, w2);
    }
    const w3 = fakeWorld();
    w3.data.channels.delete(C.botLog); // one system channel cannot be read
    await refused({ kind: 'role.assign', member: U.alice, role: R.staff }, /could not be read/, w3);
    void w;
  });
});

describe('bot set read in one list (executor world: knownBotMembers)', () => {
  const listWorld = (d = worldData(), ids: string[] = [U.praw, U.botHq]) => {
    const w = fakeWorld(d);
    let memberCalls = 0;
    const world = {
      ...w,
      knownBotIds: () => { throw new Error('knownBotIds must not be used when knownBotMembers is present'); },
      async member(id: string) { memberCalls++; return w.member(id); },
      async knownBotMembers() { return ids.map((id) => d.members.get(id)!); },
    };
    return { world, calls: () => memberCalls };
  };

  it('takes the roles from the list and fetches no bot member one by one', async () => {
    const { world, calls } = listWorld();
    expect(await permsProblem(world, consts())).toBeNull();
    expect(calls()).toBe(0);
  });

  it('still refuses when a listed bot holds a Manage Roles role, and when the list is short', async () => {
    const d = worldData();
    d.roles.push({ id: R.extra + '3', name: 'Mgr', position: 5, managed: false, botId: null, permissions: F.ManageRoles });
    d.members.get(U.botHq)!.roleIds.push(R.extra + '3');
    expect(await permsProblem(listWorld(d).world, consts())).toMatch(/only the executor's own integration role/);
    expect(await permsProblem(listWorld(worldData(), [U.praw]).world, consts())).toMatch(/not every configured bot/);
  });

  it('a list read that throws propagates (the readiness caller refuses)', async () => {
    const { world } = listWorld();
    await expect(permsProblem({ ...world, knownBotMembers: async () => { throw new Error('429'); } }, consts())).rejects.toThrow('429');
  });
});
