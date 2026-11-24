CREATE TABLE tasks (
  short_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  guild_id          INTEGER NOT NULL,
  origin_channel_id INTEGER NOT NULL,
  thread_id         INTEGER UNIQUE,
  embed_message_id  INTEGER,
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description       TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  created_by_kind   TEXT NOT NULL CHECK (created_by_kind IN ('human','agent')),
  created_by_id     TEXT NOT NULL,
  assignee_agent    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','failed','cancelled')),
  report            TEXT CHECK (length(report) <= 4000),
  parent_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;
CREATE INDEX tasks_status_idx ON tasks (status, assignee_agent);

CREATE TABLE brainstorm_threads (
  id                 TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  kind               TEXT NOT NULL CHECK (kind IN ('task','brainstorm')),
  task_id            TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  guild_id           INTEGER NOT NULL,
  parent_channel_id  INTEGER NOT NULL,
  thread_id          INTEGER UNIQUE,
  topic              TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 200),
  owner_agent        TEXT NOT NULL,
  participants       TEXT NOT NULL CHECK (json_valid(participants) AND json_type(participants) = 'array'),
  turn_limit         INTEGER NOT NULL DEFAULT 10 CHECK (turn_limit BETWEEN 1 AND 50),
  turns_used         INTEGER NOT NULL DEFAULT 0 CHECK (turns_used >= 0),
  token_budget       INTEGER NOT NULL CHECK (token_budget > 0),
  tokens_used        INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','summarising','closed','aborted')),
  close_reason       TEXT CHECK (close_reason IN ('turn_limit','token_budget','owner_ended','cancelled','restart','error')),
  initiated_by_kind  TEXT NOT NULL CHECK (initiated_by_kind IN ('human','agent')),
  initiated_by_id    TEXT NOT NULL,
  summary_message_id INTEGER,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  closed_at          TEXT CHECK (closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', closed_at)),
  CHECK (instr(participants, json_quote(owner_agent)) > 0),
  CHECK ((kind = 'task' AND json_array_length(participants) BETWEEN 1 AND 6)
      OR (kind = 'brainstorm' AND json_array_length(participants) BETWEEN 2 AND 6))
) STRICT;
CREATE INDEX brainstorm_daily_idx ON brainstorm_threads (initiated_by_kind, created_at);
CREATE INDEX brainstorm_open_idx ON brainstorm_threads (status) WHERE status IN ('open','summarising');

CREATE TABLE jobs (
  id               TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  kind             TEXT NOT NULL CHECK (length(kind) BETWEEN 1 AND 64 AND kind GLOB '[a-z]*' AND kind NOT GLOB '*[^a-z0-9_]*'),
  payload          TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','timed_out','cancelled')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts BETWEEN 1 AND 5),
  timeout_s        INTEGER NOT NULL CHECK (timeout_s BETWEEN 1 AND 3600),
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  pid              INTEGER,
  exit_code        INTEGER,
  result           TEXT CHECK (json_valid(result)),
  error            TEXT CHECK (length(error) <= 2000),
  created_by       TEXT NOT NULL,
  run_after        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (run_after = strftime('%Y-%m-%dT%H:%M:%fZ', run_after)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  started_at       TEXT CHECK (started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  finished_at      TEXT CHECK (finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', finished_at))
) STRICT;
CREATE INDEX jobs_queue_idx ON jobs (run_after, created_at) WHERE status = 'queued';
CREATE INDEX jobs_running_idx ON jobs (status) WHERE status = 'running';

CREATE TABLE approvals (
  id                TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  kind              TEXT NOT NULL CHECK (kind IN ('generic','artifact_enable','file_write_outside','destructive_cmd','config_change')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  summary           TEXT NOT NULL CHECK (length(summary) <= 4000),
  access            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(access) AND json_type(access) = 'array'),
  payload           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  requested_by      TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('discord','cli')),
  human_user_id     INTEGER,
  origin_channel_id INTEGER NOT NULL,
  origin_thread_id  INTEGER,
  channel_id        INTEGER,
  message_id        INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by        TEXT CHECK ((decided_by GLOB 'discord:*' AND length(decided_by) BETWEEN 25 AND 28 AND substr(decided_by, 9) NOT GLOB '*[^0-9]*')
                                OR (decided_by GLOB 'cli:[a-z]*' AND length(decided_by) BETWEEN 5 AND 36 AND substr(decided_by, 5) NOT GLOB '*[^a-z0-9_-]*')),
  decided_at        TEXT CHECK (decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  expires_at        TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL))
) STRICT;
CREATE INDEX approvals_pending_idx ON approvals (expires_at) WHERE status = 'pending';

CREATE TABLE usage_events (
  id             INTEGER PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  day            TEXT NOT NULL CHECK (day = date(day)),
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  purpose        TEXT NOT NULL CHECK (purpose IN ('chat','tier2','brainstorm','summary','image','tts','stt','note')),
  input_tokens   INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens  INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  units          INTEGER NOT NULL DEFAULT 0 CHECK (units >= 0),
  cost_micro_usd INTEGER NOT NULL CHECK (cost_micro_usd >= 0),
  ref            TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at))
) STRICT;
CREATE INDEX usage_agent_day_idx ON usage_events (agent_id, day);

CREATE TABLE budgets (
  agent_id              TEXT NOT NULL PRIMARY KEY,
  daily_limit_micro_usd INTEGER NOT NULL CHECK (daily_limit_micro_usd > 0),
  updated_by            TEXT NOT NULL CHECK ((updated_by GLOB 'discord:*' AND length(updated_by) BETWEEN 25 AND 28 AND substr(updated_by, 9) NOT GLOB '*[^0-9]*')
                                             OR (updated_by GLOB 'cli:[a-z]*' AND length(updated_by) BETWEEN 5 AND 36 AND substr(updated_by, 5) NOT GLOB '*[^a-z0-9_-]*')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;

CREATE TABLE budget_notices (
  agent_id TEXT NOT NULL,
  day      TEXT NOT NULL CHECK (day = date(day)),
  level    TEXT NOT NULL CHECK (level IN ('warn80','fallback100','stop120')),
  sent_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', sent_at)),
  PRIMARY KEY (agent_id, day, level)
) STRICT;

CREATE TABLE voice_optouts (
  guild_id     INTEGER NOT NULL,
  user_id      INTEGER NOT NULL,
  source       TEXT NOT NULL CHECK (source IN ('button','dm_button','command')),
  opted_out_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (opted_out_at = strftime('%Y-%m-%dT%H:%M:%fZ', opted_out_at)),
  PRIMARY KEY (guild_id, user_id)
) STRICT;

CREATE TABLE voice_sessions (
  id                TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  guild_id          INTEGER NOT NULL,
  voice_channel_id  INTEGER NOT NULL,
  text_channel_id   INTEGER NOT NULL,
  notice_message_id INTEGER,
  started_by        INTEGER NOT NULL,
  recording         INTEGER NOT NULL DEFAULT 0 CHECK (recording IN (0,1)),
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','processing','done','failed')),
  note_path         TEXT,
  job_id            TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  started_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (started_at = strftime('%Y-%m-%dT%H:%M:%fZ', started_at)),
  ended_at          TEXT CHECK (ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', ended_at))
) STRICT;

CREATE TABLE voice_notice_deliveries (
  session_id   TEXT NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('channel','dm')),
  delivered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', delivered_at)),
  PRIMARY KEY (session_id, user_id)
) STRICT;

CREATE TABLE conversation_state (
  channel_id    INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,
  agent_id      TEXT NOT NULL,
  last_reply_at TEXT NOT NULL CHECK (last_reply_at = strftime('%Y-%m-%dT%H:%M:%fZ', last_reply_at)),
  PRIMARY KEY (channel_id, user_id)
) STRICT;
