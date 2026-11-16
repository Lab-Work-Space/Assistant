import { DEFAULT_DUTIES } from '../company/duties.js';
import type { ConfigKey, ConfigValue } from './schema.js';

// Gemini: https://ai.google.dev/gemini-api/docs/pricing, gemini-3.8-flash Standard paid tier, fetched 2026-10-31. The page lists $0.75 in /
// $3.75 out / $0.075 cached through 2026-12-31 and $1.50 / $7.50 / $0.15 from 2027-01-01 (output includes thinking tokens; audio/image
// input is billed as input here, PF16). The higher 2027 rates are used so the budget guard never under-counts; revisit after the cut-over.
// Pricing: USD per MTok, claude-api skill table cached 2026-10-06 (haiku cache-read assumed 10% of input; controller ruling R2).
const WEB = ['web_search', 'fetch_page'];
// Teamwork D: forums are read-only knowledge for every head (forum_post is a write tool: an operator grants it per department).
const FORUM = ['forum_read'];
// RFMD P2: every head may read pictures (read_image); an operator removes it per department with /bot tools.
const VISION = ['read_image'];
// RFMD P3: every head is offered doc_create; the tool itself checks the kind's duty against the LIVE duties.byDept table at every call (RF22, RF35) and asks for approval where required.
// RFMD P5: image/video generation is offered to the duty holders only (marketing, rnd, praw); the tools also check the duty in code at every call (RF34, RF35).
const IMG = ['image_generate'];
// OD-5 (owner, 2026-11-07): video is OFF. video_generate is not offered to any department and the tool is not registered (tools/plugins/media/index.ts).
const DOCS = ['doc_create', 'diagram_create']; // P4 / RF27: diagram_create for every head, no approval through NO_APPROVAL_TOOLS only
/** WS-1: the project workspace tools; software only (DEPT_ONLY in tools/policy.ts keeps them out of every other department). Order matches migration 040. */
const WS = ['ws_create', 'ws_list', 'ws_read', 'ws_write', 'ws_delete', 'ws_run', 'ws_export'];
// Read-only by explicit name, no globs (P16b). Names not registered yet are dropped by the policy until their milestone.
const CLICKUP_READ = ['clickup_list_projects', 'clickup_list_open_tasks', 'clickup_list_members', 'clickup_list_comments', 'clickup_get_task_detail', 'clickup_analyze_project', 'clickup_search_tasks'];
const GITHUB_READ = ['github_get_me', 'github_list_my_organizations', 'github_list_org_repositories', 'github_list_user_repositories', 'github_search_repositories', 'github_get_repository_info', 'github_list_repository_issues', 'github_list_repository_pulls', 'github_list_repository_commits', 'github_get_issue', 'github_get_pull_request'];

export const CONFIG_DEFAULTS: { [K in ConfigKey]: ConfigValue<K> } = {
  'budget.companyDailyUsd': 5,
  'budget.botDailyUsd': 1,
  'budget.taskUsd': 0.5,
  'approval.thresholdUsd': 1,
  'approval.expiryHours': 24,
  'limits.turnsPerTask': 20,
  'limits.depth': 3,
  'limits.concurrency': 4,
  'limits.childrenPerTask': 5,
  'limits.openTasks': 20,
  'limits.humanRunsPer10Min': 5,
  'limits.prawPerUser10Min': 20,
  'limits.prawConcurrency': 3,
  'limits.visionPerUserDay': 30,
  'forum.postsPerHeadPerDay': 5,
  // TW1: runs a bot-to-bot trigger may start per warroom thread / in the whole warroom per hour. TW3: consecutive bot turns before the CEO stall turn.
  'warroom.turnsPerThreadPerHour': 30,
  'warroom.turnsPerHour': 120,
  'warroom.stallTurns': 20,
  // TW4: 50% of limits.localCallsPerDay (200) and of budget.companyDailyUsd (5). TW6: bot-created root tasks per UTC day. TW14: off-day held warroom starts.
  'warroom.localCallsPerDay': 100,
  'warroom.dailyUsd': 2.5,
  'warroom.botDailyUsd': 0.5,
  'warroom.rootTasksPerDay': 10,
  'warroom.heldMax': 50,
  'meetings.adHocPerDay': 2,
  'meetings.weekly': [
    { day: 1, time: '09:00', kind: 'planning', topic: 'Weekly planning' },
    { day: 3, time: '14:00', kind: 'progress', topic: 'Progress check' },
    { day: 5, time: '16:00', kind: 'review', topic: 'Weekly review' },
  ],
  'limits.voiceMinPerUserDay': 30,
  'limits.localCallsPerDay': 200,
  'limits.localCallsPerTask': 40,
  'limits.localUnlimited': true,
  'limits.localBotCallsAlert': 300,
  'limits.remindersPerUser': 20,
  'limits.schedulesPerUser': 5,
  'limits.watchesPerUser': 5,
  'limits.remindersTotal': 500,
  'limits.schedulesTotal': 50,
  'limits.watchesTotal': 50,
  'lessons.promptChars': 3000,
  'lessons.perLessonChars': 500,
  'limits.localConcurrency': 2,
  'schedule.timezone': 'Asia/Bangkok',
  'schedule.offDays': [0, 6],
  'schedule.holidays': [],
  'schedule.workDays': [],
  'provider.localTimeoutMs': 120_000,
  'context.messages': 30,
  halted: false,
  'provider.default': { provider: 'claude', model: 'claude-sonnet-5-5' },
  'provider.fallback.enabled': false,
  pricing: {
    'claude-sonnet-5-5': { inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.2 },
    'claude-haiku-5-5': { inPerMTok: 0.1, outPerMTok: 0.5, cacheReadPerMTok: 0.01 },
    'gemini-3.8-flash': { inPerMTok: 1.5, outPerMTok: 7.5, cacheReadPerMTok: 0.15 },
  },
  'tools.byDept': {
    hq: [...WEB, ...FORUM, ...VISION, ...DOCS], rnd: [...WEB, ...FORUM, ...VISION, ...DOCS, ...IMG], sales: [...WEB, ...FORUM, ...VISION, ...DOCS], praw: [...WEB, ...FORUM, ...VISION, ...DOCS, ...IMG],
    software: [...WEB, ...FORUM, ...VISION, ...DOCS, ...GITHUB_READ, ...CLICKUP_READ, ...WS],
    it: [...WEB, ...FORUM, ...VISION, ...DOCS, ...GITHUB_READ, ...CLICKUP_READ],
    ops: [...WEB, ...FORUM, ...VISION, ...DOCS, ...CLICKUP_READ],
    hr: [...WEB, ...FORUM, ...VISION, ...DOCS, ...CLICKUP_READ],
    marketing: [...WEB, ...FORUM, ...VISION, ...DOCS, ...IMG, ...CLICKUP_READ],
    finance: [...WEB, ...FORUM, ...VISION, ...DOCS, 'extract_receipt'],
  },
  'clickup.pollIntervalSec': 120,
  'clickup.writesPerDay': 50,
  'clickup.pollListIds': [],
  'devjob.enabled': false,
  'devjob.budgetUsd': 20,
  'devjob.jobCapUsd': 2,
  'devjob.ownerUserId': null,
  'welcome.enabled': false,
  'welcome.roleIds': [],
  'welcome.message': '',
  'welcome.channelId': null,
  'welcome.raidPerMinute': 10,
  'roles.managerId': null,
  'roles.moderatorId': null,
  'roles.modRoomId': null,
  'clickup.notifyChannelId': null,
  'ocr.autoChannelId': null,
  'github.repoAllowlist': [],
  'net.extraPorts': [],
  'teamtalk.enabled': true,
  'reroute.enabled': true,
  'ask.enabled': true,
  'ask.timeoutHours': 4,
  'ask.perRoot': 6,
  'ask.perDay': 40,
  'stream.enabled': true,
  'web.search.openSources': true,
  'web.taskGrant.enabled': true,
  'web.taskGrant.hours': 4,
  'web.taskGrant.maxFetches': 20,
  'web.taskGrant.maxHosts': 5,
  'web.taskGrant.maxUrlChars': 4000,
  // TREEGRANT-1: "Approve the whole task". All handler keys; only `enabled` has a /settings path, the rest are the owner's (psql).
  'taskGrant.enabled': true,
  'taskGrant.hours': 12,
  'taskGrant.conversationHours': 4,
  'taskGrant.maxCalls': 40,
  'taskGrant.allowTainted': true,
  // HEAL-1: self-healing (Gate 1 HL-C2). Handler keys; only `enabled` has a /settings path.
  'heal.enabled': true,
  'heal.maxRetries': 2,
  'heal.maxWakesPerTask': 2,
  'heal.maxWakesPerDeciderDay': 10,
  // OPS-HOLD: a non-conversation task in review with nothing open under it is closed by code after this many hours; 0 = off. psql only.
  'review.autoCloseHours': 24,
  'warroom.stallQuietMinutes': 60,
  'warroom.quietLiftsPerDay': 3,
  'warroom.personLiftsPerDay': 4,
  // WS-1: project workspaces (off until Gate 2). Handler keys.
  'ws.enabled': false,
  'ws.maxRunsPerTree': 40,
  'ws.maxRunsPerDay': 200,
  'release.enabled': true,
  // R6 MCP-1: off until the owner switches it on in /settings. Handler keys.
  'mcp.enabled': false,
  'mcp.maxCallsPerTree': 40,
  'mcp.maxCallsPerDay': 200,
  // R7 PLUGIN-FORGE: off until the owner builds the base image and switches it on in /settings. Handler key.
  'forge.enabled': false,
  // AUTO-1: project autopilot. Handler keys; only `enabled` has a /settings path.
  'autopilot.enabled': true,
  'autopilot.maxApprovalsPerProject': 500,
  // AUTO-2: company autopilot. Project scope until the owner flips it (psql). Handler keys.
  'autopilot.scope': 'project',
  'autopilot.company.maxApprovalsPerDay': 600,
  'autopilot.company.maxApprovalsPerTree': 80,
  'autopilot.company.maxApprovalsPerPersonDay': 200,
  // AI-APPROVE-1: the AI approver (Gate 1 AA-C17). Handler keys; only `enabled` has a /settings path. Off until the owner turns it on.
  'approval.ai.enabled': false,
  'approval.ai.maxPerTree': 40,
  'approval.ai.maxPerDay': 300,
  // GROW-1: weekly retro (Friday 16:00 in schedule.timezone) and AI skill review (off until Gate 2 and the owner). Handler keys; only the switches have a /settings path.
  'grow.retro.enabled': true,
  'grow.retro.weekday': 5,
  'grow.retro.hour': 16,
  'skills.ai.enabled': false,
  'grow.incidents.enabled': true,
  'grow.retro.incidentThreshold': 5,
  'skills.seed.enabled': true,
  'skills.ai.maxPerDeptWeek': 1,
  'skills.ai.maxPerWeek': 5,
  // OT-1: overtime requests on off days. All handler keys; only `enabled` has a /settings path, the caps are the owner's (psql).
  'ot.enabled': true,
  'ot.hours': 4,
  'ot.maxRuns': 30,
  'ot.maxUsd': 2,
  'ot.requestsPerRootPerDay': 2,
  'ot.requestsPerDay': 20,
  'ot.requestsPerPersonPerDay': 4,
  'approvals.channelByCategory': {},
  'rhythm.dailyGoalChannelId': null,
  'rhythm.dailyGoalTime': '09:00',
  'rhythm.eveningReportTime': '20:00',
  'dashboard.channelId': null,
  'duties.byDept': Object.fromEntries(Object.entries(DEFAULT_DUTIES).map(([d, v]) => [d, [...v]])),
  'company.profile': null,
  'voice.maxSessionMin': 60,
  'voice.idleMin': 10,
  'voice.stt': 'gemini',
  'voice.silenceMs': 900,
  'voice.ttsVoice': 'th-TH-NiwatNeural',
  // RFMD P5 (RF28, M2, OD-3). USD per million tokens, Standard paid tier, from the pricing page fetched 2026-11-07 (Gate 1 addendum table).
  'media.image.inPerMTok': 1.5,
  'media.image.textOutPerMTok': 7.5,
  'media.image.imageOutPerMTok': 30,
  'media.video.inPerMTok': 1.5,
  'media.video.textOutPerMTok': 9,
  'media.video.videoOutPerMTok': 12,
  'media.imagesPerDay': 20,
  'media.videosPerDay': 2,
  'media.imagesPerPersonPerDay': 5,
  'media.videosPerPersonPerDay': 1,
  'media.ytHostAllowlist': ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
  // SPEND-1: no department cap until a Bot Admin sets one; the alerts and the weekly summary are on.
  'spend.deptMonthlyUsd': {},
  'spend.warnPct': 80,
  'spend.anomalyMultiplier': 3,
  'spend.anomalyMinUsd': 0.5,
  'spend.alertsEnabled': true,
  'spend.weeklySummary': true,
  'spend.weeklySummaryTime': '09:00',
  'spend.overrideStepPct': 25,
  'spend.retentionDays': 400,
};
