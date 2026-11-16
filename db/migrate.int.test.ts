import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './migrate.js';
import { freshDb, type TestDb } from './test-helpers.js';
import { ADMIN, MAN, newBuild, newForge, newRelease, newServer, resetForgeTables } from './repos/forge-test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const APP_TABLES = [
  'plugin_forges', 'plugin_builds', 'mcp_servers', 'mcp_server_depts', 'mcp_call_counts', 'autopilot_company_counts', 'tree_tools', 'dept_incidents',
  'spend_alerts', 'spend_days', 'spend_overrides', 'task_grants', 'admin_cards', 'approval_batches', 'approvals', 'audit_log', 'bot_messages', 'budget_days', 'channel_map', 'config', 'departments', 'dept_notes',
  'board_messages', 'clickup_seen', 'clickup_write_usage', 'daily_runs', 'media_jobs', 'media_usage', 'dash_login_tokens', 'dash_sessions', 'deploy_jobs', 'deploy_uploads', 'dev_job_bundles', 'dev_jobs', 'exec_outbox', 'exec_state', 'guard_state', 'kb_docs', 'kb_proposals', 'kb_reflections', 'kb_review_runs', 'kb_versions', 'lessons', 'music_state', 'ot_requests', 'panel_state', 'persona_webhooks', 'personas', 'prompt_overrides', 'provider_keys', 'reminders', 'retro_runs', 'room_entries', 'scheduled_jobs', 'server_archives', 'skill_attachments', 'skill_proposals', 'skill_versions', 'skills', 'task_questions', 'tasks', 'tool_ideas', 'tool_requests', 'watches', 'web_grants', 'welcome_seen', 'quota_alerts', 'quota_snapshot', 'projects', 'project_tools', 'workspaces', 'ws_run_counts', 'releases',
];

let db: TestDb;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const tables = async () =>
  (await db.pool.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
  )).rows.map((r) => r.table_name);

describe('migrate', () => {
  it('up creates all tables then down drops them', async () => {
    expect(await migrate(db.pool, dir, 'up')).toEqual(['001_init', '002_approval_kind', '003_blocked_reason', '004_local_calls', '005_awaiting_approval', '006_task_origin', '007_tool_approvals', '008_praw_m2', '009_clickup_seen', '010_music_state', '011_taint_provenance', '012_admin_cards', '013_dashboard_panel', '014_server_mgmt', '015_knowledge', '016_vps_deploy', '017_dev_jobs', '018_task_messages', '019_work_style', '020_daily_rhythm', '021_warroom_say', '022_reply_forward', '023_vision_grant', '024_media', '025_offday_notice', '026_approval_batch', '027_web_grants', '028_teamtalk', '029_spend', '030_ot_requests', '031_skills', '032_reroute', '033_task_questions', '034_clickup_write_usage', '035_task_grants', '036_task_blocked_note', '037_heal', '038_ai_approver', '039_grow', '040_workspaces', '041_quota', '042_autopilot', '043_autopilot_company', '044_learn_loop', '045_release', '046_mcp', '047_mcp_pin', '048_forge']);
    expect(await tables()).toEqual([...APP_TABLES, 'schema_migrations'].sort());
    expect(await migrate(db.pool, dir, 'down')).toEqual(['048_forge', '047_mcp_pin', '046_mcp', '045_release', '044_learn_loop', '043_autopilot_company', '042_autopilot', '041_quota', '040_workspaces', '039_grow', '038_ai_approver', '037_heal', '036_task_blocked_note', '035_task_grants', '034_clickup_write_usage', '033_task_questions', '032_reroute', '031_skills', '030_ot_requests', '029_spend', '028_teamtalk', '027_web_grants', '026_approval_batch', '025_offday_notice', '024_media', '023_vision_grant', '022_reply_forward', '021_warroom_say', '020_daily_rhythm', '019_work_style', '018_task_messages', '017_dev_jobs', '016_vps_deploy', '015_knowledge', '014_server_mgmt', '013_dashboard_panel', '012_admin_cards', '011_taint_provenance', '010_music_state', '009_clickup_seen', '008_praw_m2', '007_tool_approvals', '006_task_origin', '005_awaiting_approval', '004_local_calls', '003_blocked_reason', '002_approval_kind', '001_init']);
    expect(await tables()).toEqual(['schema_migrations']);
  });

  it('010 music_state bounds the stored queue and volume like the player does', async () => {
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO music_state (guild_id, queue, volume, paused) VALUES ('g', '[]', 150, true)");
    await expect(db.pool.query("UPDATE music_state SET volume = 151 WHERE guild_id = 'g'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE music_state SET queue = '{}'::jsonb WHERE guild_id = 'g'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE music_state SET queue = (SELECT jsonb_agg(i) FROM generate_series(1, 51) i) WHERE guild_id = 'g'")).rejects.toThrow(/check/i);
    await db.pool.query('DELETE FROM music_state');
  });

  it('036 (TA-C13): owner reason and blocked_note with the backstop CHECK; up, down and up again', async () => {
    await migrate(db.pool, dir, 'up');
    const ins = (id: string, status: string, reason: string | null, note: string | null) =>
      db.pool.query(
        `INSERT INTO tasks (id, title, description, dept_id, owner, requester, root_id, depth, status, origin, tainted, blocked_reason, blocked_note)
         VALUES ($1,'t','','hq','{}'::jsonb,'{}'::jsonb,$1,0,$2,'chat',false,$3,$4)`, [id, status, reason, note]);
    await db.pool.query("INSERT INTO departments (id, name, category_name_pattern, color, enabled) VALUES ('hq','hq','',0,true) ON CONFLICT DO NOTHING");
    await ins('own1', 'blocked', 'owner', 'need the API key');
    await ins('own2', 'blocked', 'owner', null);
    await ins('own3', 'blocked', null, null);
    // a note on a row that is not an owner-blocked one is refused (the backstop), as is a note over 300 characters
    await expect(ins('bad1', 'todo', null, 'stale')).rejects.toThrow(/tasks_blocked_note_owner/);
    await expect(ins('bad2', 'blocked', 'budget', 'x')).rejects.toThrow(/tasks_blocked_note_owner/);
    await expect(ins('bad3', 'blocked', 'owner', 'x'.repeat(301))).rejects.toThrow(/check/i);
    await expect(ins('bad4', 'blocked', 'nope', null)).rejects.toThrow(/tasks_blocked_reason_check/);
    // moving the status without clearing the note fails loudly
    await expect(db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = 'own1'")).rejects.toThrow(/tasks_blocked_note_owner/);
    await db.pool.query("UPDATE tasks SET status = 'cancelled', blocked_reason = NULL, blocked_note = NULL WHERE id = 'own1'");
    expect(await migrate(db.pool, dir, 'down')).toContain('036_task_blocked_note');
    const cols = await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'blocked_note'");
    expect(cols.rowCount).toBe(0);
    await migrate(db.pool, dir, 'up');
  });

  it('up is idempotent', async () => {
    await migrate(db.pool, dir, 'up');
    expect(await migrate(db.pool, dir, 'up')).toEqual([]);
    const n = await db.pool.query('SELECT 1 FROM schema_migrations');
    expect(n.rowCount).toBe(48);
  });

  it('re-running 004 up never zeroes existing local call counts (it fails instead)', async () => {
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, calls) VALUES ('2026-10-31', 'local', '', 7) ON CONFLICT (day, scope, scope_id) DO UPDATE SET calls = 7");
    await expect(db.pool.query(readFileSync(join(dir, '004_local_calls.up.sql'), 'utf8'))).rejects.toThrow(/already exists/);
    const r = await db.pool.query<{ calls: number }>("SELECT calls FROM budget_days WHERE scope = 'local'");
    expect(r.rows).toEqual([{ calls: 7 }]);
  });

  it('migration 006 up/down round-trips and existing rows become delegated', async () => {
    await migrate(db.pool, dir, 'down');
    const old = mkdtempSync(join(tmpdir(), 'mig005-'));
    for (const f of readdirSync(dir)) if (!f.startsWith('006_') && !f.startsWith('007_') && !f.startsWith('008_') && !f.startsWith('009_') && !f.startsWith('010_') && !f.startsWith('011_') && !f.startsWith('012_') && !f.startsWith('013_') && !f.startsWith('014_') && !f.startsWith('015_') && !f.startsWith('016_') && !f.startsWith('017_') && !f.startsWith('018_') && !f.startsWith('019_') && !f.startsWith('020_') && !f.startsWith('021_') && !f.startsWith('022_') && !f.startsWith('023_') && !f.startsWith('024_') && !f.startsWith('031_') && !f.startsWith('037_') && !f.startsWith('038_') && !f.startsWith('039_') && !f.startsWith('040_') && !f.startsWith('041_') && !f.startsWith('042_') && !f.startsWith('043_') && !f.startsWith('044_') && !f.startsWith('045_') && !f.startsWith('046_') && !f.startsWith('047_') && !f.startsWith('048_')) copyFileSync(join(dir, f), join(old, f));
    await migrate(db.pool, old, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id) VALUES ('old','t','hq','{}','{}','old')");
    expect(await migrate(db.pool, dir, 'up')).toEqual(['006_task_origin', '007_tool_approvals', '008_praw_m2', '009_clickup_seen', '010_music_state', '011_taint_provenance', '012_admin_cards', '013_dashboard_panel', '014_server_mgmt', '015_knowledge', '016_vps_deploy', '017_dev_jobs', '018_task_messages', '019_work_style', '020_daily_rhythm', '021_warroom_say', '022_reply_forward', '023_vision_grant', '024_media', '031_skills', '037_heal', '038_ai_approver', '039_grow', '040_workspaces', '041_quota', '042_autopilot', '043_autopilot_company', '044_learn_loop', '045_release', '046_mcp', '047_mcp_pin', '048_forge']);
    const cols = async () =>
      (await db.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name IN ('origin','channel_id','source_user_id') ORDER BY 1")).rows.map((r) => r.column_name);
    expect(await cols()).toEqual(['channel_id', 'origin', 'source_user_id']);
    expect((await db.pool.query("SELECT origin, channel_id, source_user_id FROM tasks WHERE id = 'old'")).rows).toEqual([{ origin: 'delegated', channel_id: null, source_user_id: null }]);
    expect((await db.pool.query("SELECT column_default FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'tasks' AND column_name = 'origin'")).rows).toEqual([{ column_default: null }]);
    expect((await db.pool.query("SELECT tainted FROM tasks WHERE id = 'old'")).rows).toEqual([{ tainted: true }]); // 011: rows that predate taint tracking count as tainted
    expect(await migrate(db.pool, dir, 'down')).toContain('006_task_origin');
    expect(await cols()).toEqual([]);
    await migrate(db.pool, dir, 'up');
    expect(await cols()).toEqual(['channel_id', 'origin', 'source_user_id']);
    await migrate(db.pool, dir, 'down');
  });

  it('015 knowledge: old notes count as tainted, a deleted override becomes a tombstone, down restores the old meaning of active', async () => {
    await migrate(db.pool, dir, 'down');
    const old = mkdtempSync(join(tmpdir(), 'mig015-'));
    for (const f of readdirSync(dir)) if (!f.startsWith('015_')) copyFileSync(join(dir, f), join(old, f));
    await migrate(db.pool, old, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO dept_notes (dept_id, body) VALUES ('hq', 'old note')");
    await db.pool.query("INSERT INTO prompt_overrides (ref, body, version, active) VALUES ('heads/hq', 'v1', 1, false), ('heads/it', 'i1', 1, true)");
    expect(await migrate(db.pool, dir, 'up')).toEqual(['015_knowledge']);
    expect((await db.pool.query('SELECT tainted, pinned, source FROM dept_notes')).rows).toEqual([{ tainted: true, pinned: false, source: 'task' }]);
    expect((await db.pool.query("SELECT ref, version, tombstone FROM prompt_overrides ORDER BY ref, version")).rows).toEqual([
      { ref: 'heads/hq', version: 1, tombstone: false }, { ref: 'heads/hq', version: 2, tombstone: true }, { ref: 'heads/it', version: 1, tombstone: false }]);
    await expect(db.pool.query("INSERT INTO dept_notes (dept_id, body, pinned, source) VALUES ('hq', 'x', false, 'task')")).rejects.toThrow(/null value|not-null/i); // tainted has no default
    await db.pool.query("INSERT INTO prompt_overrides (ref, body, version) VALUES ('heads/it', 'i2', 2)");
    await db.pool.query(readFileSync(join(dir, '015_knowledge.down.sql'), 'utf8'));
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '015_knowledge'");
    expect((await db.pool.query("SELECT ref, version, active FROM prompt_overrides ORDER BY ref, version")).rows).toEqual([
      { ref: 'heads/hq', version: 1, active: false }, { ref: 'heads/it', version: 1, active: false }, { ref: 'heads/it', version: 2, active: true }]);
    await db.pool.query('DELETE FROM prompt_overrides'); // the trigger is gone with 015
    await migrate(db.pool, old, 'down');
  });

  it('011 taint provenance: tasks.tainted has no default, bot_messages is keyed by message id, down removes both', async () => {
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await expect(db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin) VALUES ('t','t','hq','{}','{}','t','chat')")).rejects.toThrow(/not-null|null value/i);
    await db.pool.query("INSERT INTO bot_messages (message_id, channel_id, tainted) VALUES ('m1','c',false)");
    await expect(db.pool.query("INSERT INTO bot_messages (message_id, channel_id, tainted) VALUES ('m1','c',true)")).rejects.toThrow(/duplicate/i);
    await db.pool.query(readFileSync(join(dir, '011_taint_provenance.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'tainted' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT to_regclass('bot_messages') AS t")).rows[0].t).toBeNull();
    await db.pool.query(readFileSync(join(dir, '011_taint_provenance.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });

  it('migration 007 up/down: tool kind and columns, tool rows required fields, down removes tool rows', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    const ins = (kind: string, extra = '') =>
      db.pool.query(`INSERT INTO approvals (task_id, reason, requested_by, kind${extra ? ', tool_name, tool_input, input_sha256' : ''}) VALUES ('t','r','x','${kind}'${extra})`);
    await expect(ins('tool')).rejects.toThrow(/check/i); // a tool approval without a stored call
    await ins('tool', ", 'n', '{\"a\":1}', 'abc'");
    await ins('estimate');
    const cols = (await db.pool.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'approvals' AND column_name IN ('tool_name','tool_input','input_sha256','executed_at','tool_result','result_delivered_at') ORDER BY 1")).rows.map((r) => r.column_name);
    expect(cols).toEqual(['executed_at', 'input_sha256', 'result_delivered_at', 'tool_input', 'tool_name', 'tool_result']);
    await migrate(db.pool, dir, 'down'); // down drops every table; re-check the single step explicitly
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    await ins('tool', ", 'n', '{}', 'abc'");
    await ins('estimate');
    await db.pool.query(readFileSync(join(dir, '007_tool_approvals.down.sql'), 'utf8'));
    expect((await db.pool.query('SELECT kind FROM approvals')).rows).toEqual([{ kind: 'estimate' }]);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'approvals' AND column_name IN ('tool_name','tool_result','result_delivered_at') AND table_schema = current_schema()")).rowCount).toBe(0);
    await db.pool.query(readFileSync(join(dir, '007_tool_approvals.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });

  it('migration 018 is additive (existing rows keep NULL ids, nothing is backfilled) and its down drops only what it added', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    expect((await db.pool.query('SELECT log_message_id, card_message_id FROM tasks')).rows).toEqual([{ log_message_id: null, card_message_id: null }]);
    await expect(db.pool.query("UPDATE tasks SET log_message_id = 'not-a-snowflake'")).rejects.toThrow(/check/i);
    await db.pool.query("INSERT INTO board_messages (key, channel_id, message_id) VALUES ('tasks-board','1565671253803794494','1570000000000000001')");
    await db.pool.query(readFileSync(join(dir, '018_task_messages.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'board_messages' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name IN ('log_message_id','card_message_id') AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query('SELECT id, title FROM tasks')).rows).toEqual([{ id: 't', title: 't' }]); // the task survives
    await db.pool.query(readFileSync(join(dir, '018_task_messages.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });

  it('migration 019 is additive (existing tasks keep their rows, conversation defaults false), checks snowflakes, and its down drops only what it added', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    expect((await db.pool.query('SELECT origin_category_id, conversation, origin_message_id FROM tasks')).rows).toEqual([{ origin_category_id: null, conversation: false, origin_message_id: null }]);
    await expect(db.pool.query("UPDATE tasks SET origin_category_id = 'nope'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE tasks SET origin_message_id = 'nope'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO guard_state (key) VALUES ('not-a-snowflake')")).rejects.toThrow(/check/i);
    await db.pool.query("INSERT INTO guard_state (key, run_count, stalled) VALUES ('1570000000000000001', 3, true)");
    await db.pool.query(readFileSync(join(dir, '019_work_style.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'guard_state' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name IN ('origin_category_id','conversation','origin_message_id') AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query('SELECT id, title FROM tasks')).rows).toEqual([{ id: 't', title: 't' }]);
    await db.pool.query(readFileSync(join(dir, '019_work_style.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });

  it('migration 020 is additive: one claim row per (day, kind), checked shapes, and its down drops only that table', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    expect((await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-02','goal') ON CONFLICT DO NOTHING")).rowCount).toBe(1);
    expect((await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-02','goal') ON CONFLICT DO NOTHING")).rowCount).toBe(0);
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-02','other')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('yesterday','goal')")).rejects.toThrow(/check/i);
    await db.pool.query(readFileSync(join(dir, '020_daily_rhythm.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'daily_runs' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'guard_state' AND table_schema = current_schema()")).rowCount).toBe(1);
    await db.pool.query(readFileSync(join(dir, '020_daily_rhythm.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });
  it('migration 021 is additive: one nullable checked snowflake column, and its down drops only that column', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    expect((await db.pool.query('SELECT warroom_say_id FROM tasks')).rows).toEqual([{ warroom_say_id: null }]);
    await expect(db.pool.query("UPDATE tasks SET warroom_say_id = 'not-a-snowflake'")).rejects.toThrow(/check/i);
    await db.pool.query("UPDATE tasks SET warroom_say_id = '1570000000000000001'");
    await db.pool.query(readFileSync(join(dir, '021_warroom_say.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name = 'warroom_say_id' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query('SELECT id, title FROM tasks')).rows).toEqual([{ id: 't', title: 't' }]);
    await db.pool.query(readFileSync(join(dir, '021_warroom_say.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });
  it('migration 022 is additive: answer defaults false, forwards defaults 0, forward_card is checked, and its down drops only those columns', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    await db.pool.query("INSERT INTO bot_messages (message_id, channel_id, tainted) VALUES ('1570000000000000001','1570000000000000002',false)");
    expect((await db.pool.query('SELECT forwards, forward_card FROM tasks')).rows).toEqual([{ forwards: 0, forward_card: null }]);
    expect((await db.pool.query('SELECT answer FROM bot_messages')).rows).toEqual([{ answer: false }]);
    await expect(db.pool.query("UPDATE tasks SET forward_card = 'other'")).rejects.toThrow(/check/i);
    await db.pool.query(readFileSync(join(dir, '022_reply_forward.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND ((table_name = 'tasks' AND column_name IN ('forwards','forward_card')) OR (table_name = 'bot_messages' AND column_name = 'answer'))")).rowCount).toBe(0);
    expect((await db.pool.query('SELECT id FROM tasks')).rows).toEqual([{ id: 't' }]);
    await db.pool.query(readFileSync(join(dir, '022_reply_forward.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });
  it('RF14: migration 023 adds read_image to each stored tools.byDept list once, leaves other keys alone, and is a no-op without a stored value', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    const up = readFileSync(join(dir, '023_vision_grant.up.sql'), 'utf8');
    await db.pool.query('DELETE FROM config');
    await db.pool.query(up);
    expect((await db.pool.query('SELECT 1 FROM config')).rowCount).toBe(0);
    await db.pool.query(`INSERT INTO config (key, value) VALUES ('tools.byDept', '{"hq":["web_search"],"it":["read_image","web_search"]}'), ('halted', 'false')`);
    await db.pool.query(up);
    await db.pool.query(up);
    expect((await db.pool.query("SELECT value FROM config WHERE key = 'tools.byDept'")).rows[0].value).toEqual({ hq: ['web_search', 'read_image'], it: ['read_image', 'web_search'] });
    expect((await db.pool.query("SELECT value FROM config WHERE key = 'halted'")).rows[0].value).toBe(false);
    await migrate(db.pool, dir, 'down');
  });
  it('TEAMTALK T14 / spec (h): 028 is additive, checked, and its down is clean with and without 027 applied', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t','t','hq','{}','{}','t','chat',false)");
    expect((await db.pool.query('SELECT acceptance, due_on, handoff_message_id, result_message_id FROM tasks')).rows).toEqual([{ acceptance: null, due_on: null, handoff_message_id: null, result_message_id: null }]);
    await expect(db.pool.query("UPDATE tasks SET acceptance = repeat('x', 301)")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE tasks SET handoff_message_id = 'nope'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE tasks SET result_message_id = 'nope'")).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE tasks SET due_on = '2026-02-31'")).rejects.toThrow(/date/i);
    await db.pool.query("INSERT INTO room_entries (persona_id, dept_id, kind, body) VALUES ('p','hq','idea','x')");
    expect((await db.pool.query('SELECT tainted FROM room_entries')).rows).toEqual([{ tainted: true }]); // fail safe default
    await expect(db.pool.query("INSERT INTO room_entries (persona_id, dept_id, kind, body) VALUES ('p','hq','other','x')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO room_entries (persona_id, dept_id, kind, body) VALUES ('p','hq','idea', repeat('x', 401))")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO room_entries (persona_id, dept_id, kind, body, message_id) VALUES ('p','hq','idea','x','nope')")).rejects.toThrow(/check/i);
    // down with 027 applied
    await db.pool.query(readFileSync(join(dir, '028_teamtalk.down.sql'), 'utf8'));
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'room_entries' AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'tasks' AND column_name IN ('acceptance','due_on','handoff_message_id','result_message_id') AND table_schema = current_schema()")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'web_grants' AND table_schema = current_schema()")).rowCount).toBe(1);
    expect((await db.pool.query('SELECT id, title FROM tasks')).rows).toEqual([{ id: 't', title: 't' }]);
    // up again, then without 027: 028 does not depend on it (migrate() applies by name set; the 027 gap is harmless)
    await db.pool.query(readFileSync(join(dir, '028_teamtalk.up.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '028_teamtalk.down.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '035_task_grants.down.sql'), 'utf8')); // TREEGRANT-1: task_grants.web_grant_id references web_grants
    await db.pool.query(readFileSync(join(dir, '027_web_grants.down.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '028_teamtalk.up.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '028_teamtalk.down.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '027_web_grants.up.sql'), 'utf8'));
    await db.pool.query(readFileSync(join(dir, '035_task_grants.up.sql'), 'utf8'));
    await migrate(db.pool, dir, 'down');
  });

  it('SPEND-1 S18: 029 backfills by department with the dept regex, its down removes the dept rows, up/down/up is clean, and the CHECKs hold', async () => {
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await db.pool.query(sql('029_spend.down.sql'));
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq'), ('Bad Dept','bad')");
    await db.pool.query("INSERT INTO personas (id, dept_id, name, prompt_ref) VALUES ('p1','hq','p','x'), ('p2','Bad Dept','q','x')");
    const today = (await db.pool.query<{ d: string }>("SELECT to_char(current_date,'YYYY-MM-DD') AS d")).rows[0]!.d;
    await db.pool.query(
      `INSERT INTO budget_days (day, scope, scope_id, spent_usd) VALUES
        (current_date, 'bot', 'head:hq', 1.5), (current_date, 'bot', 'persona:p1', 2), (current_date, 'bot', 'head:Bad!', 3),
        (current_date, 'bot', 'persona:p2', 1), (current_date, 'warroom_bot', 'head:hq', 0.5), (current_date, 'company', '', 99), (current_date, 'bot', 'head:rnd', 0)`);
    await db.pool.query(sql('029_spend.up.sql'));
    const sd = (await db.pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, dept_id, provider, tool, spent_usd::float8 AS usd FROM spend_days ORDER BY dept_id")).rows;
    expect(sd).toEqual([{ day: today, dept_id: '_unattributed', provider: 'unknown', tool: 'unknown', usd: 4 }, { day: today, dept_id: 'hq', provider: 'unknown', tool: 'unknown', usd: 4 }]);
    const dept = (await db.pool.query("SELECT scope_id, spent_usd::float8 AS usd FROM budget_days WHERE scope = 'dept' ORDER BY scope_id")).rows;
    expect(dept).toEqual([{ scope_id: '_unattributed', usd: 4 }, { scope_id: 'hq', usd: 4 }]);
    await db.pool.query(sql('029_spend.down.sql'));
    expect((await db.pool.query("SELECT 1 FROM budget_days WHERE scope = 'dept'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM budget_days WHERE scope = 'bot'")).rowCount).toBe(5);
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name LIKE 'spend_%' AND table_schema = current_schema()")).rowCount).toBe(0);
    await db.pool.query(sql('029_spend.up.sql'));
    const ins = (v: string) => db.pool.query(`INSERT INTO spend_days (day, dept_id, provider, model, tool) VALUES ${v}`);
    await expect(ins("(current_date,'HQ','gemini','','llm')")).rejects.toThrow(/check/i);
    await expect(ins("(current_date,'hq','Gem ini','','llm')")).rejects.toThrow(/check/i);
    await expect(ins("(current_date,'hq','gemini','a b','llm')")).rejects.toThrow(/check/i);
    await expect(ins("(current_date,'hq','gemini','','Bad-Tool')")).rejects.toThrow(/check/i);
    await expect(ins(`(current_date,'hq','gemini','${'m'.repeat(129)}','llm')`)).rejects.toThrow(/check/i);
    await ins("(current_date,'hq','gemini','gemini-2.5-flash','image_generate')");
    const ov = (cols: string) => db.pool.query(`INSERT INTO spend_overrides (id, dept_id, month, old_cap_usd, new_cap_usd, channel_id, expires_at) VALUES ('${'a'.repeat(32)}', 'hq', ${cols}, '1', now())`);
    await expect(ov("'2026-11-02', 1, 2")).rejects.toThrow(/check/i); // not a month start
    await expect(ov("'2026-11-01', 2, 2")).rejects.toThrow(/check/i); // must go up
    await expect(ov("'2026-11-01', 999999.99, 1000000")).rejects.toThrow(/check|overflow/i); // SP-01
    await ov("'2026-11-01', 1, 999999.99");
    await expect(db.pool.query("INSERT INTO spend_alerts (period, kind, scope_id) VALUES ('2026-11', 'bogus', '')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO spend_alerts (period, kind, scope_id) VALUES ('nov', 'warn', 'hq')")).rejects.toThrow(/check/i);
    await db.pool.query("INSERT INTO spend_alerts (period, kind, scope_id) VALUES ('2026-W53', 'summary', ''), ('2026-11-08', 'anomaly', '_company'), ('2026-11', 'warn', 'hq')");
    await db.pool.query(sql('029_spend.down.sql'));
    await db.pool.query(sql('029_spend.up.sql'));
    await migrate(db.pool, dir, 'down');
  });
  it('migration 037 (HEAL-1): guard_state gets the quiet clock and lift counters, daily_runs accepts kind heal, and down restores both', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO guard_state (key, run_count) VALUES ('1570000000000000002', 1)");
    expect((await db.pool.query("SELECT quiet_lifts, person_lifts, lift_day, last_bot_turn_at FROM guard_state")).rows).toEqual([{ quiet_lifts: 0, person_lifts: 0, lift_day: null, last_bot_turn_at: null }]);
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-09','heal')");
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-09','other')")).rejects.toThrow(/check/i);
    await db.pool.query(sql('037_heal.down.sql'));
    expect((await db.pool.query("SELECT 1 FROM daily_runs WHERE kind = 'heal'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'guard_state' AND column_name IN ('last_bot_turn_at','quiet_lifts','person_lifts','lift_day') AND table_schema = current_schema()")).rowCount).toBe(0);
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-09','heal')")).rejects.toThrow(/check/i);
    await db.pool.query(sql('037_heal.up.sql'));
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-10','heal')");
    await migrate(db.pool, dir, 'down');
  });
  it('migration 038 (AI-APPROVE-1): approvals.ai_review (max 200) and daily_runs kind ai_digest; down restores both', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-09','ai_digest')");
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t1','t','hq','{}','{}','t1','chat',false)");
    await db.pool.query("INSERT INTO approvals (task_id, reason, requested_by, ai_review) VALUES ('t1','r','x','ok')");
    await expect(db.pool.query("INSERT INTO approvals (task_id, reason, requested_by, ai_review) VALUES ('t1','r','x',$1)", ['x'.repeat(201)])).rejects.toThrow(/check/i);
    await db.pool.query(sql('038_ai_approver.down.sql'));
    expect((await db.pool.query("SELECT 1 FROM daily_runs WHERE kind = 'ai_digest'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'approvals' AND column_name = 'ai_review' AND table_schema = current_schema()")).rowCount).toBe(0);
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-09','ai_digest')")).rejects.toThrow(/check/i);
    await db.pool.query(sql('038_ai_approver.up.sql'));
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-10','ai_digest')");
    await migrate(db.pool, dir, 'down');
  });
  it('migration 039 (GROW-1): retro claim per (dept, week) with checked shapes, skill_proposals.ai_review max 200, tool tables; down drops them; up/down/up is clean', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    const tid = '11111111-1111-1111-1111-111111111111';
    await db.pool.query("INSERT INTO retro_runs (dept_id, week, task_id) VALUES ('software','2026-W45',$1)", [tid]);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week) VALUES ('software','2026-W45')")).rejects.toThrow(/duplicate|unique/i);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week, task_id) VALUES ('hr','2026-W46',$1)", [tid])).rejects.toThrow(/duplicate|unique/i);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week) VALUES ('hr','2026-W54')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week, outcome) VALUES ('hr','2026-W46','x')")).rejects.toThrow(/check/i);
    const prop = (r: string) => db.pool.query("INSERT INTO skill_proposals (dept_id, kind, skill_id, target_kind, target_id, payload, verdict, proposer, ai_review) VALUES ('hq','create','sk-x','dept','hq','{}','{}','head:hq',$1)", [r]);
    await expect(prop('x'.repeat(201))).rejects.toThrow(/check/i);
    await prop('x'.repeat(200));
    for (const t of ['tool_requests', 'tool_ideas']) expect((await tables()).includes(t)).toBe(true);
    await db.pool.query(sql('048_forge.down.sql')); // 048 holds foreign keys to tool_ideas and a CHECK on dept_incidents: it goes first
    await db.pool.query(sql('044_learn_loop.down.sql')); // 044 builds on retro_runs: take it off first, put it back after
    await db.pool.query(sql('039_grow.down.sql'));
    const t2 = await tables();
    for (const t of ['retro_runs', 'tool_requests', 'tool_ideas']) expect(t2.includes(t)).toBe(false);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'skill_proposals' AND column_name = 'ai_review' AND table_schema = current_schema()")).rowCount).toBe(0);
    await db.pool.query(sql('039_grow.up.sql'));
    await db.pool.query(sql('044_learn_loop.up.sql'));
    await db.pool.query(sql('048_forge.up.sql'));
    await migrate(db.pool, dir, 'down');
  });
  it('migration 042 (AUTO-1): projects and project_tools with checked shapes; the root and approval constraints hold; down drops both; up/down/up is clean', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('r1','t','hq','{}','{}','r1','chat',false)");
    const base = (over: Record<string, string> = {}) => {
      const v: Record<string, string> = { token: "'" + 'a'.repeat(32) + "'", title: "'T'", goal: "'g'", deadline: "'2026-12-01'", max_local_calls: '10', max_usd: '1', max_approvals: '500', base_local_calls: '10', base_usd: '1', base_approvals: '500', proposer: "'head:hq'", expires_at: "now() + interval '7 days'", ...over };
      return db.pool.query(`INSERT INTO projects (${Object.keys(v).join(',')}) VALUES (${Object.values(v).join(',')})`);
    };
    await base();
    await expect(base()).rejects.toThrow(/duplicate|unique/i); // token is unique
    await expect(base({ token: "'" + 'b'.repeat(31) + "'" })).rejects.toThrow(/check/i);
    await expect(base({ token: "'" + 'c'.repeat(32) + "'", title: "''" })).rejects.toThrow(/check/i);
    await expect(base({ token: "'" + 'c'.repeat(32) + "'", proposer: "'user:1'" })).rejects.toThrow(/check/i);
    await expect(base({ token: "'" + 'c'.repeat(32) + "'", expires_at: "now() + interval '8 days'" })).rejects.toThrow(/check/i);
    await expect(base({ token: "'" + 'c'.repeat(32) + "'", max_usd: '100001' })).rejects.toThrow(/check/i);
    await expect(base({ token: "'" + 'c'.repeat(32) + "'", base_approvals: '5001' })).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE projects SET status = 'active'")).rejects.toThrow(/projects_root/); // active needs a root task
    await expect(db.pool.query("UPDATE projects SET root_task_id = 'r1'")).rejects.toThrow(/projects_approved/); // a root needs approved_by and approved_at
    await expect(db.pool.query("UPDATE projects SET root_task_id = 'missing', approved_by = '123456789012345678', approved_at = now()")).rejects.toThrow(/foreign key/i);
    await db.pool.query("UPDATE projects SET status = 'active', root_task_id = 'r1', approved_by = '123456789012345678', approved_at = now(), deadline_noticed_at = now()");
    await expect(db.pool.query("UPDATE projects SET approvals_used = -1")).rejects.toThrow(/check/i);
    const id = (await db.pool.query<{ id: number }>('SELECT id FROM projects')).rows[0]!.id;
    await db.pool.query("INSERT INTO project_tools (project_id, dept_id, tool) VALUES ($1,'sales','read_file')", [id]);
    await expect(db.pool.query("INSERT INTO project_tools (project_id, dept_id, tool) VALUES ($1,'sales','read_file')", [id])).rejects.toThrow(/duplicate|unique/i);
    await expect(db.pool.query("INSERT INTO project_tools (project_id, dept_id, tool) VALUES ($1,'Sales','x')", [id])).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO project_tools (project_id, dept_id, tool) VALUES (999,'sales','x')")).rejects.toThrow(/foreign key/i);
    await db.pool.query('DELETE FROM project_tools');
    await db.pool.query('DELETE FROM projects');
    await db.pool.query(sql('048_forge.down.sql'));
    await db.pool.query(sql('047_mcp_pin.down.sql'));
    await db.pool.query(sql('046_mcp.down.sql')); // 046 holds a foreign key to releases: it goes first
    await db.pool.query(sql('045_release.down.sql')); // 045 holds a foreign key to projects: it goes first
    await db.pool.query(sql('042_autopilot.down.sql'));
    const t2 = await tables();
    for (const t of ['projects', 'project_tools']) expect(t2.includes(t)).toBe(false);
    await db.pool.query(sql('042_autopilot.up.sql'));
    await db.pool.query(sql('045_release.up.sql'));
    await db.pool.query(sql('046_mcp.up.sql'));
    await db.pool.query(sql('047_mcp_pin.up.sql'));
    await db.pool.query(sql('048_forge.up.sql'));
    expect((await tables()).includes('projects')).toBe(true);
    await db.pool.query('DELETE FROM tasks');
    await migrate(db.pool, dir, 'down');
  });
  it('migration 043 (AUTO-2): company counters (day, tree, person scopes with checked keys), tree_tools, the autopilot_cap daily kind; down removes them and restores the kind list; up/down/up is clean', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq')");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('r1','t','hq','{}','{}','r1','chat',false)");
    const cnt = (scope: string, key: string) => db.pool.query('INSERT INTO autopilot_company_counts (scope, scope_key, used) VALUES ($1,$2,1)', [scope, key]);
    await cnt('day', '2026-11-12');
    await cnt('tree', 'r1');
    await cnt('person', '2026-11-12:123456789012345678');
    await expect(cnt('day', '2026-11-12')).rejects.toThrow(/duplicate|unique/i);
    await expect(cnt('day', 'not-a-date')).rejects.toThrow(/check/i);
    await expect(cnt('tree', '')).rejects.toThrow(/check/i);
    await expect(cnt('tree', 'x'.repeat(65))).rejects.toThrow(/check/i);
    await expect(cnt('person', '')).rejects.toThrow(/check/i);
    await expect(cnt('week', 'x')).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE autopilot_company_counts SET used = -1")).rejects.toThrow(/check/i);
    const tt = (root: string, dept: string, tool: string) => db.pool.query('INSERT INTO tree_tools (root_task_id, dept_id, tool) VALUES ($1,$2,$3)', [root, dept, tool]);
    await tt('r1', 'sales', 'read_file');
    await expect(tt('r1', 'sales', 'read_file')).rejects.toThrow(/duplicate|unique/i);
    await expect(tt('r1', 'Sales', 'x')).rejects.toThrow(/check/i);
    await expect(tt('r1', 'sales', 'Bad-Tool')).rejects.toThrow(/check/i);
    await expect(tt('missing', 'sales', 'x')).rejects.toThrow(/foreign key/i);
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-12','autopilot_cap')");
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-12','bogus')")).rejects.toThrow(/check/i);
    await db.pool.query(sql('043_autopilot_company.down.sql'));
    const t2 = await tables();
    for (const t of ['tree_tools', 'autopilot_company_counts']) expect(t2.includes(t)).toBe(false);
    expect((await db.pool.query("SELECT 1 FROM daily_runs WHERE kind = 'autopilot_cap'")).rowCount).toBe(0);
    await expect(db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-13','autopilot_cap')")).rejects.toThrow(/check/i);
    await db.pool.query("INSERT INTO daily_runs (day, kind) VALUES ('2026-11-13','ai_digest')");
    await db.pool.query(sql('043_autopilot_company.up.sql'));
    expect((await tables()).includes('tree_tools')).toBe(true);
    await db.pool.query('DELETE FROM daily_runs');
    await db.pool.query('DELETE FROM tasks');
    await migrate(db.pool, dir, 'down');
  });
  it('migration 044 (LEARN-1): dept_incidents CHECKs, retro_runs kind and D-keys; down removes on-demand rows, restores the week check and drops the table; up/down/up is clean', async () => {
    await migrate(db.pool, dir, 'up');
    const sql = (f: string) => readFileSync(join(dir, f), 'utf8');
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('sales','sales') ON CONFLICT DO NOTHING");
    const inc = (kind: string, code: string, tool: string | null, task: string | null, ikey: string, n = 1) =>
      db.pool.query('INSERT INTO dept_incidents (dept_id, kind, code, tool, task_id, n, ikey) VALUES ($1,$2,$3,$4,$5,$6,$7)', ['sales', kind, code, tool, task, n, ikey]);
    const U = '11111111-1111-1111-1111-111111111111';
    await inc('task_blocked', 'error', null, U, 'task:a');
    await inc('tool_errors', 'tool_error', 'read_file', null, 'tool:d:read_file:tool_error', 3);
    await expect(inc('task_blocked', 'error', null, U, 'task:a')).rejects.toThrow(/duplicate|unique/i);
    await expect(inc('bogus', 'error', null, U, 'k1')).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'Bad Code', null, U, 'k2')).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'error', 'read_file', U, 'k3')).rejects.toThrow(/check/i);
    await expect(inc('tool_errors', 'error', 'read_file', U, 'k4')).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'error', null, 'not-a-uuid', 'k5')).rejects.toThrow(/check/i);
    await expect(inc('tool_errors', 'error', 'Bad-Tool', null, 'k6')).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'error', null, U, 'K7 upper')).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'error', null, U, 'k8', 0)).rejects.toThrow(/check/i);
    await expect(inc('task_blocked', 'error', null, U, 'k9', 100001)).rejects.toThrow(/check/i);
    const ret = (week: string, kind: string) => db.pool.query('INSERT INTO retro_runs (dept_id, week, kind) VALUES ($1,$2,$3)', ['sales', week, kind]);
    await ret('2026-W46', 'weekly');
    await ret('D2026-11-12', 'manual');
    await expect(ret('D2026-11-13', 'weekly')).rejects.toThrow(/check/i);
    await expect(ret('2026-W47', 'manual')).rejects.toThrow(/check/i);
    await expect(ret('2026-W47', 'bogus')).rejects.toThrow(/check/i);
    await expect(ret('D2026-1-1', 'incident')).rejects.toThrow(/check/i);
    await db.pool.query(sql('048_forge.down.sql')); // 048 widens the dept_incidents kind CHECK and holds keys to releases: it goes first
    await db.pool.query(sql('044_learn_loop.down.sql'));
    expect((await tables()).includes('dept_incidents')).toBe(false);
    expect((await db.pool.query('SELECT week FROM retro_runs')).rows).toEqual([{ week: '2026-W46' }]);
    expect((await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'retro_runs' AND column_name = 'kind'")).rowCount).toBe(0);
    await expect(db.pool.query("INSERT INTO retro_runs (dept_id, week) VALUES ('sales','D2026-11-12')")).rejects.toThrow(/check/i);
    await db.pool.query(sql('044_learn_loop.up.sql'));
    await db.pool.query(sql('048_forge.up.sql'));
    expect((await tables()).includes('dept_incidents')).toBe(true);
    await db.pool.query('DELETE FROM retro_runs');
    await migrate(db.pool, dir, 'down');
  });
  it('migration 047 (R6 pin): the column and its CHECKs, an active row is demoted to pending, config_changed is a quarantine reason, down maps it back; up/down/up is clean', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query(sql('048_forge.down.sql')); // 048 sits on 047's pin CHECK: it goes first and comes back last
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '048_forge'");
    await db.pool.query(sql('047_mcp_pin.down.sql')); // the state before 047 (046 stays)
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '047_mcp_pin'");
    const col = () => db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'mcp_servers' AND column_name = 'approved_config_sha256'");
    expect((await col()).rowCount).toBe(0);
    const raw = (slug: string, status: string, more = '') => db.pool.query(
      `INSERT INTO mcp_servers (slug, title, image_id, tool_class, snapshot, snapshot_sha256, added_by, status, approved_by, approved_at${more ? ', ' + more.split('|')[0] : ''})
       VALUES ($1,'t',$2,'read','[{"name":"x"}]',$3,'900000000000000001',$4, CASE WHEN $4 = 'active' THEN '900000000000000001' END, CASE WHEN $4 = 'active' THEN now() END${more ? ', ' + more.split('|')[1] : ''})`,
      [slug, `sha256:${'c'.repeat(64)}`, 'a'.repeat(64), status]);
    await raw('act', 'active'); // an approved row written under 046: no pin exists to prove what was approved
    await raw('pen', 'pending');
    await raw('qua', 'quarantined', "quarantine_reason, quarantined_at|'snapshot_changed', now()");
    await db.pool.query(sql('047_mcp_pin.up.sql'));
    await db.pool.query("INSERT INTO schema_migrations(name) VALUES ('047_mcp_pin')");
    expect((await col()).rowCount).toBe(1);
    expect((await db.pool.query<{ slug: string; status: string; approved_by: string | null; approved_at: Date | null; approved_config_sha256: string | null }>('SELECT slug, status, approved_by, approved_at, approved_config_sha256 FROM mcp_servers ORDER BY slug')).rows)
      .toEqual([{ slug: 'act', status: 'pending', approved_by: null, approved_at: null, approved_config_sha256: null }, { slug: 'pen', status: 'pending', approved_by: null, approved_at: null, approved_config_sha256: null }, { slug: 'qua', status: 'quarantined', approved_by: null, approved_at: null, approved_config_sha256: null }]);
    const con = async (name: string) => (await db.pool.query("SELECT 1 FROM pg_constraint WHERE conrelid = 'mcp_servers'::regclass AND conname = $1", [name])).rowCount;
    for (const n of ['mcp_servers_pin', 'mcp_servers_approved_config_sha256_check', 'mcp_servers_quarantine_reason_check']) expect(await con(n), n).toBe(1);
    await expect(db.pool.query("UPDATE mcp_servers SET status = 'active', approved_by = '900000000000000001', approved_at = now() WHERE slug = 'pen'")).rejects.toThrow(/mcp_servers_pin/);
    await expect(db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = 'XYZ' WHERE slug = 'pen'")).rejects.toThrow(/approved_config_sha256_check/);
    await db.pool.query("UPDATE mcp_servers SET status = 'active', approved_by = '900000000000000001', approved_at = now(), approved_config_sha256 = $1 WHERE slug = 'pen'", ['f'.repeat(64)]);
    await db.pool.query("UPDATE mcp_servers SET status = 'quarantined', quarantine_reason = 'config_changed', quarantined_at = now() WHERE slug = 'pen'");
    await expect(db.pool.query("UPDATE mcp_servers SET quarantine_reason = 'other' WHERE slug = 'pen'")).rejects.toThrow(/quarantine_reason/);
    // down: config_changed has no place in the old list, so it maps to snapshot_changed (still quarantined); the column and the new CHECKs go
    await db.pool.query(sql('047_mcp_pin.down.sql'));
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '047_mcp_pin'");
    expect((await col()).rowCount).toBe(0);
    expect(await con('mcp_servers_pin')).toBe(0);
    expect((await db.pool.query("SELECT quarantine_reason FROM mcp_servers WHERE slug = 'pen'")).rows).toEqual([{ quarantine_reason: 'snapshot_changed' }]);
    await expect(db.pool.query("UPDATE mcp_servers SET quarantine_reason = 'config_changed' WHERE slug = 'pen'")).rejects.toThrow(/quarantine_reason/);
    await db.pool.query(sql('047_mcp_pin.up.sql'));
    await db.pool.query("INSERT INTO schema_migrations(name) VALUES ('047_mcp_pin')");
    expect((await col()).rowCount).toBe(1);
    await db.pool.query(sql('048_forge.up.sql'));
    await db.pool.query("INSERT INTO schema_migrations(name) VALUES ('048_forge')");
    await migrate(db.pool, dir, 'down');
  });
  it('migration 048 (G2-MCP-R4): the pin exists exactly when the row is active; the up clears the pin of existing non-active rows first; down restores the 047 CHECK; up/down/up is clean', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    await db.pool.query(sql('048_forge.down.sql')); // the state before 048 (047 stays)
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '048_forge'");
    const pin = 'f'.repeat(64);
    const raw = (slug: string, status: string, more = '') => db.pool.query(
      `INSERT INTO mcp_servers (slug, title, image_id, tool_class, snapshot, snapshot_sha256, added_by, status, approved_by, approved_at, approved_config_sha256${more ? ', ' + more.split('|')[0] : ''})
       VALUES ($1,'t',$2,'read','[{"name":"x"}]',$3,'900000000000000001',$4,'900000000000000001', now(), $5${more ? ', ' + more.split('|')[1] : ''})`,
      [slug, `sha256:${'c'.repeat(64)}`, 'a'.repeat(64), status, pin]);
    await raw('act', 'active');
    await raw('dis', 'disabled', "disabled_by, disabled_at|'900000000000000001', now()"); // legal under 047: a leftover pin on a disabled row
    await raw('qua', 'quarantined', "quarantine_reason, quarantined_at|'snapshot_changed', now()");
    await db.pool.query(sql('048_forge.up.sql'));
    await db.pool.query("INSERT INTO schema_migrations(name) VALUES ('048_forge')");
    const q = async () => (await db.pool.query<{ slug: string; approved_by: string | null; approved_at: Date | null; approved_config_sha256: string | null }>('SELECT slug, approved_by, approved_at, approved_config_sha256 FROM mcp_servers ORDER BY slug')).rows;
    expect(await q()).toEqual([
      { slug: 'act', approved_by: '900000000000000001', approved_at: expect.any(Date), approved_config_sha256: pin },
      { slug: 'dis', approved_by: null, approved_at: null, approved_config_sha256: null },
      { slug: 'qua', approved_by: null, approved_at: null, approved_config_sha256: null },
    ]);
    await expect(db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = $1 WHERE slug = 'dis'", [pin])).rejects.toThrow(/mcp_servers_pin/);
    await expect(db.pool.query("UPDATE mcp_servers SET status = 'disabled', disabled_by = '900000000000000001', disabled_at = now() WHERE slug = 'act'")).rejects.toThrow(/mcp_servers_pin/); // still pinned
    await expect(db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = NULL WHERE slug = 'act'")).rejects.toThrow(/mcp_servers_pin/); // active without a pin
    await db.pool.query(sql('048_forge.down.sql'));
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '048_forge'");
    await db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = $1 WHERE slug = 'dis'", [pin]); // the 047 CHECK allows it again
    await db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = NULL WHERE slug = 'dis'");
    await expect(db.pool.query("UPDATE mcp_servers SET approved_config_sha256 = NULL WHERE slug = 'act'")).rejects.toThrow(/mcp_servers_pin/);
    await db.pool.query(sql('048_forge.up.sql'));
    await db.pool.query("INSERT INTO schema_migrations(name) VALUES ('048_forge')");
    await migrate(db.pool, dir, 'down');
  });
  it('migration 048 (R7, FG-AC01, PF-C20): up, down, up with forge rows, an install_plugin release and a release-sourced server present; each new CHECK refuses its bad case', async () => {
    const sql = (n: string) => readFileSync(join(dir, n), 'utf8');
    await migrate(db.pool, dir, 'down');
    await migrate(db.pool, dir, 'up');
    const q = (text: string, params: unknown[] = []) => db.pool.query(text, params);
    const names = async (t: string) => (await q('SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass', [t])).rows.map((r: { conname: string }) => r.conname);
    // the 044 inline CHECK keeps its default name (the spec's BE1 confirmation)
    expect(await names('dept_incidents')).toContain('dept_incidents_kind_check');
    expect(await names('releases')).toEqual(expect.arrayContaining(['releases_target_check', 'releases_plugin']));
    expect(await names('mcp_servers')).toEqual(expect.arrayContaining(['mcp_servers_source_check', 'mcp_servers_release', 'mcp_servers_release_write', 'mcp_servers_pin']));
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId });
    await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'building' });
    await newServer(db.pool, { slug: 'hello', status: 'active', releaseId: rel });
    await q("INSERT INTO config (key, value) VALUES ('forge.enabled','true'::jsonb)");
    const task = '11111111-1111-4111-8111-111111111111';
    await q("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey) VALUES ('software','forge_failed','verify_failed',$1,'forge:1')", [task]);
    // bad cases
    await expect(newServer(db.pool, { slug: 'readr', status: 'pending', releaseId: rel, cls: 'read' })).rejects.toThrow(/mcp_servers_release_write/); // release + read class
    await expect(q("UPDATE mcp_servers SET tool_class = 'read'")).rejects.toThrow(/mcp_servers_release_write/);
    await expect(q("UPDATE mcp_servers SET source = 'other'")).rejects.toThrow(/mcp_servers_(source_check|release)/);
    await expect(newServer(db.pool, { slug: 'dup', status: 'pending', releaseId: rel })).rejects.toThrow(/mcp_servers_release_once|duplicate/); // one server per release
    await expect(newRelease(db.pool, { forgeId: f.forgeId, status: 'pending' }).then(() => q("UPDATE releases SET forge_id = NULL WHERE status = 'pending'"))).rejects.toThrow(/releases_plugin/); // install_plugin without forge columns
    await expect(q("UPDATE releases SET target = 'github'")).rejects.toThrow(/releases_(target_check|plugin)/);
    await expect(q("UPDATE releases SET target = 'handoff' WHERE id = $1", [rel])).rejects.toThrow(/releases_plugin/); // handoff with forge columns
    await expect(q("UPDATE releases SET plugin_slug = 'Bad_Slug' WHERE id = $1", [rel])).rejects.toThrow(/check/i);
    await expect(q("UPDATE releases SET plugin_manifest_sha256 = 'zz' WHERE id = $1", [rel])).rejects.toThrow(/check/i);
    await expect(q("UPDATE plugin_builds SET zip = '\\x01'::bytea, bytes = 1, status = 'staged'")).rejects.toThrow(/plugin_builds_(zip|staged)/); // zip iff queued or building
    await expect(q("UPDATE plugin_builds SET zip = NULL")).rejects.toThrow(/plugin_builds_zip/);
    const f2 = await newForge(db.pool);
    const r2 = await newRelease(db.pool, { forgeId: f2.forgeId });
    await expect(newBuild(db.pool, { forgeId: f2.forgeId, releaseId: r2, status: 'building' })).rejects.toThrow(/plugin_builds_one_building/); // two building rows
    await expect(newBuild(db.pool, { forgeId: f2.forgeId, releaseId: r2, status: 'queued', attempts: 4 })).rejects.toThrow(/check/i);
    await expect(newBuild(db.pool, { forgeId: f2.forgeId, releaseId: r2, status: 'failed', code: '' })).rejects.toThrow(/plugin_builds_code|check/i);
    await expect(q("UPDATE plugin_builds SET image_id = 'latest'")).rejects.toThrow(/check/i);
    await expect(q("UPDATE plugin_builds SET image_bytes = 8388609, image_id = $1", [`sha256:${'2'.repeat(64)}`])).rejects.toThrow(/check/i);
    await expect(q("UPDATE plugin_builds SET image_removed_at = now()")).rejects.toThrow(/plugin_builds_removed/); // removal needs an image
    await expect(q("UPDATE plugin_forges SET status = 'staged' WHERE id = $1", [f2.forgeId])).rejects.toThrow(/plugin_forges_server/);
    await expect(q("UPDATE plugin_forges SET status = 'installed' WHERE id = $1", [f2.forgeId])).rejects.toThrow(/plugin_forges_closed|plugin_forges_installed/);
    await expect(q("UPDATE plugin_forges SET status = 'cancelled' WHERE id = $1", [f2.forgeId])).rejects.toThrow(/plugin_forges_closed/);
    await expect(q("UPDATE plugin_forges SET proposer = 'user:1' WHERE id = $1", [f2.forgeId])).rejects.toThrow(/check/i);
    await expect(q("INSERT INTO plugin_forges (idea_id, project_id, dept_id, proposer) VALUES ($1, $2, 'software', 'head:hq')", [f2.ideaId, f2.projectId])).rejects.toThrow(/duplicate|unique/i); // one forge per project
    const p3 = (await q("SELECT id FROM projects WHERE id <> $1 ORDER BY id LIMIT 1", [f2.projectId])).rows[0].id;
    await expect(q("INSERT INTO plugin_forges (idea_id, project_id, dept_id, proposer) VALUES ($1, $2, 'software', 'head:hq')", [f2.ideaId, p3])).rejects.toThrow(/plugin_forges_one_live_per_idea|duplicate|unique/i); // one live forge per idea
    await expect(q("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey) VALUES ('software','bogus','x',$1,'k')", [task])).rejects.toThrow(/dept_incidents_kind_check/);
    // down with the rows present, then up again (a release-sourced server and install_plugin releases are removed by the down)
    await q("UPDATE mcp_servers SET approved_config_sha256 = approved_config_sha256"); // no-op: the pin is held while active
    await q(sql('048_forge.down.sql'));
    await q("DELETE FROM schema_migrations WHERE name = '048_forge'");
    expect((await tables()).filter((t) => t.startsWith('plugin_'))).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM mcp_servers")).rows[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM releases WHERE target = 'install_plugin'")).rows[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM config WHERE key = 'forge.enabled'")).rows[0].n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM dept_incidents WHERE kind = 'forge_failed'")).rows[0].n).toBe(0);
    expect((await q("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = 'releases'::regclass AND conname = 'releases_target_check'")).rows[0].d).not.toContain('install_plugin'); // the old target list is back
    await expect(q("INSERT INTO dept_incidents (dept_id, kind, code, task_id, ikey) VALUES ('software','forge_failed','x',$1,'k2')", [task])).rejects.toThrow(/dept_incidents_kind_check/);
    await q(sql('048_forge.up.sql'));
    await q("INSERT INTO schema_migrations(name) VALUES ('048_forge')");
    expect((await tables()).filter((t) => t.startsWith('plugin_')).sort()).toEqual(['plugin_builds', 'plugin_forges']);
    await resetForgeTables(db.pool);
    await migrate(db.pool, dir, 'down');
    expect(ADMIN + MAN).toBeTruthy();
  });
});

