import { redactText } from '../../core/index.js';
import { adminCardButton } from './admincfg.js';
import { approvalButton } from './approval.js';
import { botColor, botList, botModel, botTools, botToggle } from './bot.js';
import { budgetDept, budgetSet } from './budget.js';
import { spendOverrideButton } from './spendovr.js';
import { mcpAdd, mcpApprove, mcpDepts, mcpDisable, mcpList, mcpShow, mcpTest } from './mcp.js';
import { forgeCancel, forgeList, forgeShow } from './forge.js';
import { releaseCardButton, releaseList, releaseReject, releaseShow } from './release.js';
import { toolRequestButton } from './toolreq.js';
import { projectBudgetButton, projectCardButton, projectClose, projectExtend, projectList, projectPause, projectRaise, projectResume, projectStart } from './project.js';
import { toolIdeaClose, toolIdeas, toolRequests } from './tool.js';
import { channelMap, channelUnmap } from './channel.js';
import { githubAllow } from './github.js';
import { autoOcrChannel } from './autoocr.js';
import { mediaAllowlist } from './media.js';
import { clickupChannel, clickupWatch } from './clickup.js';
import { haltCmd, resumeCmd } from './halt.js';
import { holidayAdd, holidayList, holidayRemove, holidayWeekdays, holidayWorkday } from './holiday.js';
import { approvalAi } from './approval.ai.js';
import { approvalSet, limitsSet } from './limits.js';
import { personaCreate, personaDelete, personaEdit, personaList, personaModalSubmit, personaReset, PERSONA_MODAL } from './persona.js';
import { providerAdd, providerDefault, providerModalSubmit, PROVIDER_MODAL } from './provider.js';
import { CONFIG_CHANNEL_ID, ephemeral, isModal, type CommandDeps, type Handler, type InteractionLike, type Reply } from './types.js';
import { wsArchive, wsList } from './ws.js';
import { retroRun } from './retro.js';
import { usageCmd } from './usage.js';
import { settingsCmd } from './settings.js';
import { dashboardCmd } from './dashboard.js';
import { taskadmButton, taskCancel, taskDone, taskList, taskRetry } from './task.js';
import { SKILL_CREATE_MODAL, SKILL_EDIT_MODAL, skillAttach, skillCreate, skillDetach, skillEdit, skillList, skillModalSubmit, skillProposals, skillReject, skillReview, skillRollback, skillShow, skillToggle, skillTools } from './skill.js';

export * from './approval.js';
export { ADMIN_CARD_ID } from '../embeds/approval.js';
export * from './definitions.js';
export * from './persona.js';
export * from './register.js';
export { CONFIG_CHANNEL_ID, type CommandDeps, type InteractionLike, type ModalSpec, type Reply } from './types.js';

const COMMAND_TABLE: Record<string, Handler> = {
  'bot:list': botList,
  'bot:enable': botToggle(true),
  'bot:disable': botToggle(false),
  'bot:model': botModel,
  'bot:color': botColor,
  'bot:tools': botTools,
  'persona:create': personaCreate,
  'persona:edit': personaEdit,
  'persona:delete': personaDelete,
  'persona:reset': personaReset,
  'persona:list': personaList,
  'channel:map': channelMap,
  'channel:unmap': channelUnmap,
  'provider:add': providerAdd,
  'provider:default': providerDefault,
  'budget:set': budgetSet,
  'budget:dept': budgetDept,
  'limits:set': limitsSet,
  'approval:set': approvalSet,
  'approval:ai': approvalAi,
  'github:allow': githubAllow,
  'clickup:channel': clickupChannel,
  'clickup:watch': clickupWatch,
  'autoocr:channel': autoOcrChannel,
  'media:allowlist': mediaAllowlist,
  'holiday:add': holidayAdd,
  'holiday:remove': holidayRemove,
  'holiday:list': holidayList,
  'holiday:weekdays': holidayWeekdays,
  'holiday:workday': holidayWorkday,
  halt: haltCmd,
  resume: resumeCmd,
  dashboard: dashboardCmd,
  'settings:list': settingsCmd,
  'settings:get': settingsCmd,
  'settings:set': settingsCmd,
  usage: usageCmd,
  'skill:list': skillList,
  'skill:show': skillShow,
  'skill:create': skillCreate,
  'skill:edit': skillEdit,
  'skill:attach': skillAttach,
  'skill:detach': skillDetach,
  'skill:tools': skillTools,
  'skill:disable': skillToggle(false),
  'skill:enable': skillToggle(true),
  'skill:rollback': skillRollback,
  'skill:proposals': skillProposals,
  'skill:review': skillReview,
  'skill:reject': skillReject,
  'tool:ideas': toolIdeas,
  'tool:idea_close': toolIdeaClose,
  'tool:requests': toolRequests,
  'task:list': taskList,
  'task:cancel': taskCancel,
  'task:retry': taskRetry,
  'task:done': taskDone,
  'project:start': projectStart,
  'project:list': projectList,
  'project:pause': projectPause,
  'project:resume': projectResume,
  'project:close': projectClose,
  'project:raise': projectRaise,
  'project:extend': projectExtend,
  'retro:run': retroRun, // LEARN-1 (LL-C7): the only caller of WeeklyRetro.request, after decide()
  'ws:list': wsList,
  'ws:archive': wsArchive,
  'release:list': releaseList, // R5 RELEASE-1: Bot Admin in #setting only (decide()); list and show escape bot text, reject carries the screened reason
  'release:show': releaseShow,
  'release:reject': releaseReject,
  // R6 MCP-1: Bot Admin in #setting only (decide()); every reply is ephemeral, inert and paged; AdminConsole has no path to these
  'mcp:list': mcpList,
  'mcp:show': mcpShow,
  'mcp:add': mcpAdd,
  'mcp:approve': mcpApprove,
  'mcp:test': mcpTest,
  'mcp:disable': mcpDisable,
  'mcp:depts': mcpDepts,
  // R7 PLUGIN-FORGE: Bot Admin in #setting only (decide()); list, show and cancel; no build, retry or GC; AdminConsole has no path to these (ADMIN_FORBIDDEN_CMD_KEYS)
  'forge:list': forgeList,
  'forge:show': forgeShow,
  'forge:cancel': forgeCancel,
};

/** Gate 1 S37a: the panel's custom ids. Only hq handles them, here; the Praw path never sees them. */
const PANEL_PREFIX = 'panel:';
const isPanel = (i: InteractionLike) => i.customId.startsWith(PANEL_PREFIX) && (i.isButton() || i.isModalSubmit() || i.isStringSelectMenu?.() === true);
const panelHandler: Handler = async (i, deps) => (deps.panel ? deps.panel.handle(i) : ephemeral('The settings panel is not available.'));

function route(i: InteractionLike): Handler | null {
  if (isPanel(i)) return panelHandler;
  if (i.isButton()) return i.customId.startsWith('approval:') ? approvalButton : i.customId.startsWith('admincfg:') ? adminCardButton : i.customId.startsWith('spendovr:') ? spendOverrideButton : i.customId.startsWith('taskadm:') ? taskadmButton : i.customId.startsWith('toolreq:') ? toolRequestButton : i.customId.startsWith('projcard:') ? projectCardButton : i.customId.startsWith('projbud:') ? projectBudgetButton : i.customId.startsWith('relcard:') ? releaseCardButton : null; // R5 RELEASE-1: relcard: only here, after the #setting and live Bot Admin checks of decide() (Gate 1 RL-C11);  AUTO-1: projcard: and projbud: only here, after the #setting and live Bot Admin checks of decide() (Gate 1 AP-C11);  GROW-1: toolreq: only here, after the channel and live admin checks of decide() (Gate 1 GW-C17);  TASKADMIN-1: taskadm: only here, after the #setting and live admin checks of decide() (TA-C1); SPEND-1: only here, after the channel and live admin checks of decide() (Gate 1 S2)
  if (i.isModalSubmit()) {
    if (i.customId.startsWith(PROVIDER_MODAL)) return providerModalSubmit;
    if (i.customId.startsWith(PERSONA_MODAL)) return personaModalSubmit;
    if (i.customId.startsWith(SKILL_CREATE_MODAL) || i.customId.startsWith(SKILL_EDIT_MODAL)) return skillModalSubmit;
    return null;
  }
  if (i.isChatInputCommand()) return COMMAND_TABLE[i.subcommand ? `${i.commandName}:${i.subcommand}` : i.commandName] ?? null;
  return null;
}

/** Guard order: guild, channel, admin role id, then the handler. Refusals are ephemeral and carry no secret content. */
/** Commands that answer with a modal must not defer (showModal needs the unacknowledged interaction). */
const MODAL_OPENERS = new Set(['provider:add', 'persona:edit', 'skill:create', 'skill:edit']);

/** Deferred results that carry nothing for the channel stay private. */
/** F4 / LF8: admin card buttons and approval decisions answer privately, to the deciding admin only (the deferral decides this: an editReply cannot make a public deferral private); the card message itself shows how it ended. */
const deferEphemeral = (i: InteractionLike) => i.isModalSubmit() || (i.isChatInputCommand() && (i.commandName === 'dashboard' || i.commandName === 'settings' || i.commandName === 'skill' || i.commandName === 'task' || i.commandName === 'tool' || i.commandName === 'project' || i.commandName === 'ws' || i.commandName === 'retro' || i.commandName === 'release' || i.commandName === 'mcp' || i.commandName === 'forge')) || (i.isButton() && (i.customId.startsWith('projcard:') || i.customId.startsWith('projbud:') || i.customId.startsWith('approval:') || i.customId.startsWith('admincfg:') || i.customId.startsWith('spendovr:') || i.customId.startsWith('taskadm:') || i.customId.startsWith('toolreq:') || i.customId.startsWith('relcard:')));

async function decide(i: InteractionLike, deps: CommandDeps): Promise<{ refusal: Reply } | { handler: Handler } | null> {
  if (i.guildId !== deps.guildId) return null; // Gate 1 D5: other guilds are dropped silently
  // T5/T4: a card posted in the mod room is confirmed there; the console checks its channel, the presser's live tier and the proposer. Nothing else leaves #⚙️-setting.
  if (i.channelId !== CONFIG_CHANNEL_ID && i.isButton() && i.customId.startsWith('admincfg:')) return { handler: adminCardButton };
  // WS7: an approval card in a category's approvals room is decided there, by a Bot Admin only (checked here on this click's live roles and again in decide()).
  if (i.channelId !== CONFIG_CHANNEL_ID && i.isButton() && i.customId.startsWith('approval:') && i.channelId && Object.values(deps.cfg.get('approvals.channelByCategory')).includes(i.channelId)) {
    return !deps.adminRoleId || !i.memberRoleIds.includes(deps.adminRoleId) ? { refusal: ephemeral('Only Bot Admins can do this.') } : { handler: approvalButton };
  }
  if (i.channelId !== CONFIG_CHANNEL_ID) return { refusal: ephemeral('Use this in #⚙️-setting.') };
  if (!deps.adminRoleId || !i.memberRoleIds.includes(deps.adminRoleId)) return { refusal: ephemeral('Only Bot Admins can do this.') };
  const handler = route(i);
  return handler ? { handler } : { refusal: ephemeral('Unknown command.') };
}

/** Returns the reply that was sent (null when the interaction was dropped). Errors never echo input. */
export async function handleInteraction(i: InteractionLike, deps: CommandDeps): Promise<Reply | null> {
  const d = await decide(i, deps);
  if (!d) return null;
  if ('refusal' in d) {
    await i.reply(d.refusal);
    return d.refusal;
  }
  // A panel component answers with showModal or a plain reply: it is never deferred (a modal cannot follow a deferral).
  const opensModal = (i.isChatInputCommand() && MODAL_OPENERS.has(i.subcommand ? `${i.commandName}:${i.subcommand}` : i.commandName)) || (isPanel(i) && !i.isModalSubmit());
  let deferred = false;
  let reply: Reply;
  try {
    if (!opensModal) {
      await i.deferReply({ ephemeral: deferEphemeral(i) });
      deferred = true;
    }
    const out = await d.handler(i, deps);
    if (isModal(out)) {
      await i.showModal(out.modal);
      return null;
    }
    reply = out;
  } catch (err) {
    // The message may come from a store; mask it and never log interaction options or modal fields.
    deps.log.error({ command: i.commandName, err: redactText(err instanceof Error ? err.message : 'error') }, 'command failed');
    reply = ephemeral('That failed; nothing was changed or the change is unconfirmed. Check the logs.');
  }
  await (deferred ? i.editReply(reply) : i.reply(reply));
  return reply;
}
