import type { ConfigStore } from '../../config/store.js';
import type { Env, Logger } from '../../core/index.js';
import type { JobRepo } from '../../db/repos/jobs.js';
import type { LessonRepo } from '../../db/repos/lessons.js';
import type { WatchRepo } from '../../db/repos/watches.js';
import type { ReminderRepo } from '../../db/repos/reminders.js';
import type { DiscordPort } from '../../discord/index.js';
import type { Org } from '../../company/org.js';
import type { ClickUpClient } from './clickup/client.js';
import type { GithubClient } from './github/client.js';
import type { Resolver, Transport } from '../../net/guard.js';
import type { WebBrowser } from './web/browser.js';
import type { DocRenderer } from './docs/render.js';
import type { MeteredModel } from '../../agents/call/metered.js';
import type { VisionCap } from '../../agents/loop/vision.js';
import type { Halt } from '../../governance/halt.js';
import type { IncidentSink } from '../../core/incidents.js';
import type { MediaGen } from './media/index.js';
import type { MusicPlayer } from '../../voice/music/index.js';
import type { WsService } from '../../workspaces/service.js';

/** What a plugin group factory may use to build its tools. Later tasks add fields. */
export type PluginDeps = {
  env: Env;
  cfg: ConfigStore;
  log: Logger;
  port: DiscordPort;
  clock: () => number;
  /** Resolver/transport for net/guard's safeFetch; tests inject fakes, production leaves it unset (system DNS and sockets). */
  /** Task 16: the reminders store; the reminders group is off without it. */
  reminders?: Pick<ReminderRepo, 'add' | 'list' | 'cancel'>;
  /** Task 17: the scheduled jobs store; the schedule group is off without it. */
  jobs?: Pick<JobRepo, 'add' | 'list' | 'remove'>;
  /** Task 18: the watches store; the watch group is off without it. */
  watches?: Pick<WatchRepo, 'add' | 'list' | 'remove'>;
  /** Task 19: the lessons store; the lessons group is off without it. */
  lessons?: Pick<LessonRepo, 'add' | 'list' | 'remove'>;
  /** Task 25: built in app.ts (token and list id never reach a tool); the clickup group is off without it. */
  clickup?: ClickUpClient;
  /** CLICKUP-ALL-1: the daily write counter (workspace mode) and the literal secrets the approval card masks; built in app.ts, never model-reachable. */
  clickupUsage?: { take(day: string, cap: number): Promise<boolean> };
  clickupSecrets?: readonly string[];
  /** Task 29: built in app.ts from validated env (key, JWT and tokens never reach a tool); the github group is off without it, with `githubDisabled` as the alert reason. */
  github?: GithubClient;
  githubDisabled?: string;
  net?: { resolver: Resolver; transport: Transport };
  /** Gate 1 Part C: local mode reads the web through headless Chrome in a container. Set (or `browserDisabled` set) only when CHROME_CDP_URL is configured; unset on the VPS and in most tests. */
  browser?: WebBrowser;
  /** Why the Chrome boot check failed: the web group is off with this as the alert reason, and nothing falls back to HTTP. */
  browserDisabled?: string;
  /** Task 32: metered model calls (Gemini, PF21) for OCR/receipts/STT; the ocr group is off without it. Never a provider or key (D16). */
  metered?: MeteredModel;
  /** Task 34: the daily per-human OCR/receipt cap (P15) and the halt/shutdown tracker for attachment downloads. */
  vision?: Pick<VisionCap, 'take'>;
  halt?: Pick<Halt, 'track'> & Partial<Pick<Halt, 'isHalted'>>;
  /** Task 35 (P22, R13): music/voice groups turned off at boot (binaries missing or mismatched, voice library not loadable); T36/T37 factories return `disabled` for their id. */
  mediaDisabled?: { id: string; why: string }[];
  /** Task 36: Praw's music player (queue, yt-dlp/ffmpeg children); the music group is off without it. */
  music?: Pick<MusicPlayer, 'play' | 'precheckPlay' | 'skip' | 'stop' | 'list' | 'setVolume'>;
  /** Teamwork D: which department a channel or forum is mapped to; the forum group is off without it. */
  org?: Pick<Org, 'deptOfChannel' | 'mappedChannelsOf' | 'persona'>;
  /** G2-04: records the taint of a post of ours (message id -> tainted, trigger user); forum_post writes the starter message here. */
  provenance?: { record(messageId: string, channelId: string, tainted: boolean, triggerUserId: string | null): Promise<void> };
  /** RFMD P3 (RF15): the document renderer (a Chrome with no route, not the web Chrome); the docs group is off without it, with `rendererDisabled` as the alert reason. */
  renderer?: DocRenderer;
  /** D-04: the department documents folder (absolute); validated by the docs group (tools/plugins/docs/root.ts). */
  docsDir?: string;
  rendererDisabled?: string;
  /** BOTLOG-1: the renderer was configured but its boot check failed (an error, not just "not configured"). */
  rendererFailed?: true;
  /** RFMD P5: image/video generation (built in app.ts from the Gemini key; tools never see it). The media group is off without it. */
  mediaGen?: MediaGen;
  /** BOTLOG-1: where tool faults are reported (#bot-log). */
  incidents?: IncidentSink;
  /** Task 20: absolute path of Praw's sandboxed workspace (P18); the workspace group is off without it. */
  workspaceRoot?: string;
  /** WS-1: the project workspace service (built in app.ts after bootWorkspaces); the ws group is off without it, with `wsDisabled` as the alert reason. */
  ws?: WsService;
  wsDisabled?: string;
  /** WS-1: WS_ROOT was set (or Docker answered with an error) but the check failed: an error, not just "not configured". */
  wsFailed?: true;
  /** WS-1: the literal app secrets, for redacting container output (used by ws_run, WS-BE2). Never model-reachable. */
  wsSecrets?: readonly string[];
};
