-- Server management (phase 2, Gate 1 S1-S33). The executor "LW Admin" is its own process; it reads a confirmed card by id from admin_cards,
-- claims it exactly once (executed_at) and writes the rows below. The main application never holds the executor's token.

-- A new card family (server ops) and where the proposal came from (praw | panel | dashboard; set by code, never by the model).
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server'));
ALTER TABLE admin_cards ADD COLUMN via text NOT NULL DEFAULT 'praw' CHECK (via IN ('praw', 'panel', 'dashboard'));
-- S2/S46: set by the executor's single conditional UPDATE; a card runs at most once, even with two parallel applies.
ALTER TABLE admin_cards ADD COLUMN executed_at timestamptz;

-- S30: the rate caps are counted from audit rows, so the lookup needs an index.
CREATE INDEX audit_log_action_ts_idx ON audit_log (action, ts);

-- S13: the raid pause survives a restart (key 'welcome.paused': {since, reason}); only a confirmed card clears it.
CREATE TABLE exec_state (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Executor -> main application messages (the executor has no Send Messages and no other bot's token): welcome posts, raid alerts, bot-log summaries.
CREATE TABLE exec_outbox (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('welcome.post', 'alert', 'summary')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz
);
CREATE INDEX exec_outbox_open_idx ON exec_outbox (id) WHERE done_at IS NULL;

-- S11: one welcome per user id per 24 h (rejoin loops). Ids only.
CREATE TABLE welcome_seen (
  user_id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);

-- S16: the executor's OWN record of when it archived a channel; dragging a channel into the Archive category by hand writes no row.
CREATE TABLE server_archives (
  channel_id text PRIMARY KEY,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archived_by text NOT NULL
);
