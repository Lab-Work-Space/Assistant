import { ChannelType, InteractionContextType, SlashCommandBuilder, type SlashCommandIntegerOption, type SlashCommandStringOption } from 'discord.js';
import { DEPT_IDS } from '../../core/index.js';
import { SPEND_MAX_USD } from '../../config/schema.js';
import { LIMIT_KEYS } from './limits.js';

const depts = DEPT_IDS.map((d) => ({ name: d, value: d }));
const choices = (vals: readonly string[]) => vals.map((v) => ({ name: v, value: v }));
const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
/** Teamwork D: /channel map and unmap also take a forum (its posts route to the department head). */
const MAPPABLE = [...TEXT, ChannelType.GuildForum] as const;

const bot = new SlashCommandBuilder().setName('bot').setDescription('Department head bots')
  .addSubcommand((s) => s.setName('list').setDescription('List heads'))
  .addSubcommand((s) => s.setName('enable').setDescription('Enable a head').addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts)))
  .addSubcommand((s) => s.setName('disable').setDescription('Disable a head').addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts)))
  .addSubcommand((s) => s.setName('model').setDescription('Set a head model')
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts))
    .addStringOption((o) => o.setName('provider').setDescription('Provider id').setRequired(true).setMaxLength(64))
    .addStringOption((o) => o.setName('model').setDescription('Model id (needs a pricing entry)').setRequired(true).setMaxLength(128)))
  .addSubcommand((s) => s.setName('tools').setDescription('Add or remove a department tool')
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts))
    .addStringOption((o) => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(...choices(['add', 'remove'])))
    .addStringOption((o) => o.setName('tool').setDescription('Tool name').setRequired(true).setMaxLength(64)))
  .addSubcommand((s) => s.setName('color').setDescription('Set embed color')
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts))
    .addStringOption((o) => o.setName('hex').setDescription('Hex color like #3498db').setRequired(true).setMaxLength(7)));

const persona = new SlashCommandBuilder().setName('persona').setDescription('Department members')
  .addSubcommand((s) => s.setName('create').setDescription('Create a member')
    .addStringOption((o) => o.setName('name').setDescription('Display name').setRequired(true).setMaxLength(80))
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts))
    .addStringOption((o) => o.setName('avatar').setDescription('https avatar URL').setMaxLength(512)))
  .addSubcommand((s) => s.setName('edit').setDescription('Edit a member prompt').addStringOption((o) => o.setName('persona').setDescription('Persona id').setRequired(true)))
  .addSubcommand((s) => s.setName('delete').setDescription('Delete a member').addStringOption((o) => o.setName('persona').setDescription('Persona id').setRequired(true)))
  .addSubcommand((s) => s.setName('reset').setDescription('Reset a member prompt to default').addStringOption((o) => o.setName('persona').setDescription('Persona id').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('List members'));

const channel = new SlashCommandBuilder().setName('channel').setDescription('Channel routing')
  .addSubcommand((s) => s.setName('map').setDescription('Map a channel to a department')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel or forum').setRequired(true).addChannelTypes(...MAPPABLE))
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...depts))
    .addBooleanOption((o) => o.setName('work').setDescription('Treat as the department work channel')))
  .addSubcommand((s) => s.setName('unmap').setDescription('Remove a mapping').addChannelOption((o) => o.setName('channel').setDescription('Channel or forum').setRequired(true).addChannelTypes(...MAPPABLE)));

const provider = new SlashCommandBuilder().setName('provider').setDescription('LLM providers')
  .addSubcommand((s) => s.setName('add').setDescription('Store an API key (asked in a private modal)').addStringOption((o) => o.setName('id').setDescription('Provider id').setRequired(true).setMaxLength(32)))
  .addSubcommand((s) => s.setName('default').setDescription('Set the default provider and model')
    .addStringOption((o) => o.setName('id').setDescription('Provider id').setRequired(true).setMaxLength(32))
    .addStringOption((o) => o.setName('model').setDescription('Model id (needs a pricing entry)').setRequired(true).setMaxLength(128)));

const budget = new SlashCommandBuilder().setName('budget').setDescription('Budgets')
  .addSubcommand((s) => s.setName('set').setDescription('Set a budget in USD')
    .addStringOption((o) => o.setName('scope').setDescription('Scope').setRequired(true).addChoices(...choices(['daily', 'bot', 'task'])))
    .addNumberOption((o) => o.setName('usd').setDescription('USD').setRequired(true).setMinValue(0).setMaxValue(1_000_000)))
  .addSubcommand((s) => s.setName('dept').setDescription('Set or clear a department monthly budget in USD (months of the schedule time zone)')
    .addStringOption((o) => o.setName('dept').setDescription('Department').setRequired(true).addChoices(...choices([...DEPT_IDS])))
    .addNumberOption((o) => o.setName('usd').setDescription('Monthly USD').setMinValue(0).setMaxValue(SPEND_MAX_USD))
    .addBooleanOption((o) => o.setName('clear').setDescription('Remove the cap')));

const limits = new SlashCommandBuilder().setName('limits').setDescription('Conversation and fan-out limits')
  .addSubcommand((s) => s.setName('set').setDescription('Set a limit')
    .addStringOption((o) => o.setName('limit').setDescription('Limit').setRequired(true).addChoices(...choices(Object.keys(LIMIT_KEYS))))
    .addIntegerOption((o) => o.setName('value').setDescription('Value').setRequired(true).setMinValue(1).setMaxValue(10_000)));

const approval = new SlashCommandBuilder().setName('approval').setDescription('Approval threshold and AI approvals')
  .addSubcommand((s) => s.setName('ai').setDescription('Pause or resume AI approvals for today')
    .addStringOption((o) => o.setName('action').setDescription('pause or resume').setRequired(true).addChoices(...choices(['pause', 'resume']))))
  .addSubcommand((s) => s.setName('set').setDescription('Set the approval threshold in USD')
    .addNumberOption((o) => o.setName('usd').setDescription('USD').setRequired(true).setMinValue(0).setMaxValue(1_000_000)));

const github = new SlashCommandBuilder().setName('github').setDescription('GitHub write tools')
  .addSubcommand((s) => s.setName('allow').setDescription('Add or remove a repository on the write allowlist')
    .addStringOption((o) => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(...choices(['add', 'remove'])))
    .addStringOption((o) => o.setName('repo').setDescription('owner/repo').setRequired(true).setMaxLength(220)));

const clickup = new SlashCommandBuilder().setName('clickup').setDescription('ClickUp notifications')
  .addSubcommand((s) => s.setName('channel').setDescription('Channel for ClickUp notices (leave empty to clear and use Praw\'s work channel)')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(...TEXT)))
  .addSubcommand((s) => s.setName('watch').setDescription('Workspace mode: add or remove a ClickUp list whose changes are announced (at most 10)')
    .addStringOption((o) => o.setName('list_id').setDescription('List id (see clickup_list_projects)').setRequired(true).setMaxLength(32))
    .addStringOption((o) => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(...choices(['add', 'remove']))));

const autoocr = new SlashCommandBuilder().setName('autoocr').setDescription('Automatic image reading')
  .addSubcommand((s) => s.setName('channel').setDescription('Channel whose images Praw reads automatically (must be mapped to Praw; empty = off)')
    .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(...TEXT)));

const media = new SlashCommandBuilder().setName('media').setDescription('Music settings')
  .addSubcommand((s) => s.setName('allowlist').setDescription('Add or remove a host a music link may name')
    .addStringOption((o) => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(...choices(['add', 'remove'])))
    .addStringOption((o) => o.setName('host').setDescription('Host name, for example m.youtube.com').setRequired(true).setMaxLength(253)));

const date = (o: SlashCommandStringOption) => o.setName('date').setDescription('Date as YYYY-MM-DD').setRequired(true).setMinLength(10).setMaxLength(10);
const holiday = new SlashCommandBuilder().setName('holiday').setDescription('Off days: automated work waits, people are still answered')
  .addSubcommand((s) => s.setName('add').setDescription('Add a company holiday').addStringOption(date)
    .addStringOption((o) => o.setName('name').setDescription('Name, for example New Year').setMaxLength(60)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a company holiday').addStringOption(date))
  .addSubcommand((s) => s.setName('list').setDescription('Weekly off days and upcoming holidays'))
  .addSubcommand((s) => s.setName('weekdays').setDescription('Weekly off days, for example sat,sun (none = no weekly off day)')
    .addStringOption((o) => o.setName('days').setDescription('Day names: mon tue wed thu fri sat sun, or none').setRequired(true).setMaxLength(64)))
  .addSubcommand((s) => s.setName('workday').setDescription('Make a date a working day even on an off day (default today)')
    .addStringOption((o) => o.setName('date').setDescription('Date as YYYY-MM-DD; empty = today').setMinLength(10).setMaxLength(10))
    .addBooleanOption((o) => o.setName('remove').setDescription('Remove this extra workday instead')));

const halt = new SlashCommandBuilder().setName('halt').setDescription('Emergency stop');
const resume = new SlashCommandBuilder().setName('resume').setDescription('Resume after a halt');
const usage = new SlashCommandBuilder().setName('usage').setDescription('Cost, calls and tokens per bot, the Claude quota, or the spend trend')
  .addStringOption((o) => o.setName('range').setDescription('today, week, quota or trend').addChoices(...choices(['today', 'week', 'quota', 'trend'])))
  .addStringOption((o) => o.setName('by').setDescription('trend grouping (default dept)').addChoices(...choices(['dept', 'provider', 'tool'])));

const dashboard = new SlashCommandBuilder().setName('dashboard').setDescription('One-time sign-in link for the local web dashboard');

const settings = new SlashCommandBuilder().setName('settings').setDescription('Show and change configuration (Bot Admin; sensitive keys make a card)')
  .addSubcommand((s) => s.setName('list').setDescription('List keys with their values').addStringOption((o) => o.setName('prefix').setDescription('Only keys starting with this, for example warroom.').setMaxLength(64)))
  .addSubcommand((s) => s.setName('get').setDescription('Show one key').addStringOption((o) => o.setName('key').setDescription('Key, for example limits.depth').setRequired(true).setMaxLength(64)))
  .addSubcommand((s) => s.setName('set').setDescription('Set a key (JSON value, or plain text for text keys)')
    .addStringOption((o) => o.setName('key').setDescription('Key').setRequired(true).setMaxLength(64))
    .addStringOption((o) => o.setName('value').setDescription('New value').setRequired(true).setMaxLength(4000)));

const SKILL_OPT = (o: SlashCommandStringOption) => o.setName('skill').setDescription('Skill id').setRequired(true).setMaxLength(40);
const TARGET_OPT = (o: SlashCommandStringOption, required: boolean) => o.setName('target').setDescription('dept:<id> or persona:<id>').setRequired(required).setMaxLength(70);
const skill = new SlashCommandBuilder().setName('skill').setDescription('Team skills: instructions and templates attached to a department or member')
  .addSubcommand((s) => s.setName('list').setDescription('List skills').addStringOption((o) => TARGET_OPT(o, false)))
  .addSubcommand((s) => s.setName('show').setDescription('Show a skill version in full').addStringOption(SKILL_OPT).addIntegerOption((o) => o.setName('version').setDescription('Version (default: active)').setMinValue(1)))
  .addSubcommand((s) => s.setName('create').setDescription('Create a skill (opens a form)'))
  .addSubcommand((s) => s.setName('edit').setDescription('Edit a skill (opens a form with the active version)').addStringOption(SKILL_OPT))
  .addSubcommand((s) => s.setName('attach').setDescription('Attach a skill to a department or member').addStringOption(SKILL_OPT).addStringOption((o) => TARGET_OPT(o, true))
    .addIntegerOption((o) => o.setName('priority').setDescription('Order, lower first (default 100)').setMinValue(0).setMaxValue(1000)))
  .addSubcommand((s) => s.setName('detach').setDescription('Detach a skill').addStringOption(SKILL_OPT).addStringOption((o) => TARGET_OPT(o, true)))
  .addSubcommand((s) => s.setName('tools').setDescription('Add or remove a tool a skill gives').addStringOption(SKILL_OPT)
    .addStringOption((o) => o.setName('action').setDescription('add or remove').setRequired(true).addChoices(...choices(['add', 'remove'])))
    .addStringOption((o) => o.setName('tool').setDescription('Tool name').setRequired(true).setMaxLength(64)))
  .addSubcommand((s) => s.setName('disable').setDescription('Stop injecting a skill').addStringOption(SKILL_OPT))
  .addSubcommand((s) => s.setName('enable').setDescription('Inject a disabled skill again').addStringOption(SKILL_OPT))
  .addSubcommand((s) => s.setName('rollback').setDescription('Restore an earlier version as a new version').addStringOption(SKILL_OPT).addIntegerOption((o) => o.setName('version').setDescription('Version to restore').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('proposals').setDescription('List skill proposals from department heads'))
  .addSubcommand((s) => s.setName('review').setDescription('Read a proposal in full and get a confirmation card').addIntegerOption((o) => o.setName('proposal').setDescription('Proposal number').setRequired(true).setMinValue(1)))
  .addSubcommand((s) => s.setName('reject').setDescription('Reject a proposal').addIntegerOption((o) => o.setName('proposal').setDescription('Proposal number').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('Why (not stored)').setMaxLength(200)));

/** TASKADMIN-1: the id option is 6 to 36 characters; the handler re-checks it (`^[0-9a-f-]{6,36}$`). */
const TASK_OPT = (o: SlashCommandStringOption) => o.setName('task').setDescription('Task id (the first 6 or more characters, from /task list)').setRequired(true).setMinLength(6).setMaxLength(36);
const task = new SlashCommandBuilder().setName('task').setDescription('Task administration: list, cancel, retry or accept stuck tasks')
  .addSubcommand((s) => s.setName('list').setDescription('Open tasks, stalest first')
    .addStringOption((o) => o.setName('status').setDescription('Which tasks (default: all open)').addChoices(...choices(['open', 'blocked', 'review', 'doing', 'todo', 'awaiting_approval']))))
  .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a task (asks you to confirm)').addStringOption(TASK_OPT)
    .addStringOption((o) => o.setName('cascade').setDescription('children = also cancel every open subtask').addChoices(...choices(['children'])))
    .addStringOption((o) => o.setName('reason').setDescription('Why (shown in the audit and the subtask notice)').setMaxLength(200)))
  .addSubcommand((s) => s.setName('retry').setDescription('Move a blocked task back to todo').addStringOption(TASK_OPT)
    .addBooleanOption((o) => o.setName('reset_turns').setDescription('Give a turn-limited task a fresh turn budget')))
  .addSubcommand((s) => s.setName('done').setDescription('Accept a task in review as done (asks you to confirm)').addStringOption(TASK_OPT));

const tool = new SlashCommandBuilder().setName('tool').setDescription('Tool ideas and tool requests from department heads')
  .addSubcommand((s) => s.setName('ideas').setDescription('List open tool ideas'))
  .addSubcommand((s) => s.setName('idea_close').setDescription('Close a tool idea').addIntegerOption((o) => o.setName('id').setDescription('Idea number').setRequired(true).setMinValue(1))
    .addStringOption((o) => o.setName('reason').setDescription('Why').setMaxLength(200)))
  .addSubcommand((s) => s.setName('requests').setDescription('List tool requests waiting for a decision'));

/** AUTO-1: project autopilot. Bot Admins only, in #setting (decide() in commands/index.ts); required options come first (Discord). */
const PROJECT_ID = (o: SlashCommandIntegerOption) => o.setName('id').setDescription('Project number (from /project list)').setRequired(true).setMinValue(1);
const project = new SlashCommandBuilder().setName('project').setDescription('Project autopilot: one confirmation per project, then it runs on its own')
  .addSubcommand((s) => s.setName('start').setDescription('Propose a project (a card in #setting asks a Bot Admin to approve)')
    .addStringOption((o) => o.setName('title').setDescription('Short title').setRequired(true).setMinLength(1).setMaxLength(100))
    .addStringOption((o) => o.setName('goal').setDescription('What the project must achieve').setRequired(true).setMinLength(1).setMaxLength(1000))
    .addStringOption((o) => o.setName('deadline').setDescription('YYYY-MM-DD, up to one year ahead').setRequired(true).setMinLength(10).setMaxLength(10))
    .addNumberOption((o) => o.setName('usd').setDescription('USD budget for the whole project').setRequired(true).setMinValue(0).setMaxValue(1000))
    .addIntegerOption((o) => o.setName('calls').setDescription('Local model call budget').setRequired(true).setMinValue(1).setMaxValue(100000))
    .addStringOption((o) => o.setName('adopt').setDescription('Open root task ids to bring in (8+ characters each, separated by spaces or commas)').setMaxLength(800))
    .addIntegerOption((o) => o.setName('idea').setDescription('Tool idea number (from /tool ideas) to have built as a plugin').setRequired(false).setMinValue(1).setMaxValue(1000000000)))
  .addSubcommand((s) => s.setName('list').setDescription('List projects, newest first'))
  .addSubcommand((s) => s.setName('pause').setDescription('Pause autopilot for a project').addIntegerOption(PROJECT_ID))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume a paused project').addIntegerOption(PROJECT_ID))
  .addSubcommand((s) => s.setName('close').setDescription('End a project').addIntegerOption(PROJECT_ID))
  .addSubcommand((s) => s.setName('raise').setDescription('Add budget to a project whose budget is used up').addIntegerOption(PROJECT_ID))
  .addSubcommand((s) => s.setName('extend').setDescription('Give a project a later deadline').addIntegerOption(PROJECT_ID)
    .addStringOption((o) => o.setName('date').setDescription('New deadline YYYY-MM-DD, up to one year ahead').setRequired(true).setMinLength(10).setMaxLength(10)));

const ws = new SlashCommandBuilder().setName('ws').setDescription('Software team project workspaces')
  .addSubcommand((s) => s.setName('list').setDescription('List workspaces with status and size'))
  .addSubcommand((s) => s.setName('archive').setDescription('Make a workspace read-only').addStringOption((o) => o.setName('slug').setDescription('Workspace name').setRequired(true).setMinLength(3).setMaxLength(40)));

/** R5 RELEASE-1: Bot Admins only, in #setting (decide() in commands/index.ts). Approve and reject by button on the card; the command rejects with a reason. */
const RELEASE_ID = (o: SlashCommandIntegerOption) => o.setName('id').setDescription('Release number (from /release list)').setRequired(true).setMinValue(1);
const release = new SlashCommandBuilder().setName('release').setDescription('Release requests from the software team')
  .addSubcommand((s) => s.setName('list').setDescription('List the newest release requests'))
  .addSubcommand((s) => s.setName('show').setDescription('Show one release request').addIntegerOption(RELEASE_ID))
  .addSubcommand((s) => s.setName('reject').setDescription('Reject a waiting release request with a reason').addIntegerOption(RELEASE_ID)
    .addStringOption((o) => o.setName('reason').setDescription('Why (shown to the software head)').setRequired(true).setMinLength(1).setMaxLength(200)));

/** R6 MCP-1 (spec 5.10): Bot Admins only, in #setting (decide() in commands/index.ts). The server name is the slug; add probes the image in a sandbox and shows what the model would see. */
const MCP_SLUG = (o: SlashCommandStringOption) => o.setName('slug').setDescription('Server name (letters and digits, starts with a letter)').setRequired(true).setMinLength(2).setMaxLength(16);
const mcp = new SlashCommandBuilder().setName('mcp').setDescription('External tool servers (MCP) in a sandbox')
  .addSubcommand((s) => s.setName('list').setDescription('List the MCP servers'))
  .addSubcommand((s) => s.setName('show').setDescription('Show what the model sees for a server').addStringOption(MCP_SLUG)
    .addIntegerOption((o) => o.setName('page').setDescription('Page number when the view is long').setRequired(false).setMinValue(1).setMaxValue(50)))
  .addSubcommand((s) => s.setName('add').setDescription('Add a server (it waits for /mcp approve)').addStringOption(MCP_SLUG)
    .addStringOption((o) => o.setName('image').setDescription('Image id sha256:... (from docker image inspect)').setRequired(true).setMinLength(71).setMaxLength(71))
    .addStringOption((o) => o.setName('departments').setDescription('Department ids, comma separated').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('title').setDescription('Short title (1-80)').setRequired(true).setMinLength(1).setMaxLength(80))
    .addStringOption((o) => o.setName('class').setDescription('read (no card) or write (a card each call; default)').setRequired(false).addChoices({ name: 'read', value: 'read' }, { name: 'write', value: 'write' }))
    .addStringOption((o) => o.setName('command').setDescription('JSON array of arguments after the image').setRequired(false).setMaxLength(1000))
    .addStringOption((o) => o.setName('env').setDescription('K=V;K=V (no secrets)').setRequired(false).setMaxLength(1000))
    .addIntegerOption((o) => o.setName('timeout').setDescription('Seconds per call, 5-120').setRequired(false).setMinValue(5).setMaxValue(120))
    .addIntegerOption((o) => o.setName('daily').setDescription('Calls per day for this server, 1-1000').setRequired(false).setMinValue(1).setMaxValue(1000))
    .addStringOption((o) => o.setName('ref').setDescription('Where the image came from (display only)').setRequired(false).setMaxLength(200)))
  .addSubcommand((s) => s.setName('approve').setDescription('Install a pending server').addStringOption(MCP_SLUG)
    .addStringOption((o) => o.setName('hash').setDescription('The 12 character token from /mcp add or /mcp show').setRequired(true).setMinLength(12).setMaxLength(12)))
  .addSubcommand((s) => s.setName('test').setDescription('Check a server still matches its approved snapshot').addStringOption(MCP_SLUG))
  .addSubcommand((s) => s.setName('disable').setDescription('Switch a server off').addStringOption(MCP_SLUG))
  .addSubcommand((s) => s.setName('depts').setDescription('Replace the departments a server is granted to').addStringOption(MCP_SLUG)
    .addStringOption((o) => o.setName('departments').setDescription('Department ids, comma separated').setRequired(true).setMaxLength(200)));

/** R7 PLUGIN-FORGE (spec 5.8): Bot Admins only, in #setting (decide() in commands/index.ts). Reads and one cancel: there is no build, retry or GC command. */
const FORGE_ID = (o: SlashCommandIntegerOption) => o.setName('id').setDescription('Forge number (from /forge list)').setRequired(true).setMinValue(1);
const forge = new SlashCommandBuilder().setName('forge').setDescription('Plugin forge: bots build their own tools')
  .addSubcommand((s) => s.setName('list').setDescription('List the newest forges with their last build'))
  .addSubcommand((s) => s.setName('show').setDescription('Show one forge').addIntegerOption(FORGE_ID))
  .addSubcommand((s) => s.setName('cancel').setDescription('Cancel a forge (not while it is building; a staged server is left alone)').addIntegerOption(FORGE_ID));

const retro = new SlashCommandBuilder().setName('retro').setDescription('Extra team retros')
  .addSubcommand((s) => s.setName('run').setDescription('Queue an extra retro for a department, or for all of them')
    .addStringOption((o) => o.setName('dept').setDescription('Department id (empty = every department)').setRequired(false).setMaxLength(32)));

export const COMMANDS = [bot, persona, channel, provider, budget, limits, approval, github, clickup, autoocr, media, holiday, halt, resume, usage, dashboard, settings, skill, task, tool, project, ws, retro, release, mcp, forge].map((c) =>
  c.setContexts(InteractionContextType.Guild).toJSON(),
);
