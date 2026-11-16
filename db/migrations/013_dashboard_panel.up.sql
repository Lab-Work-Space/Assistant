-- Settings panels (Gate 1 S37b, S41-S43, S46). Additive only.
-- A card proposed from the local dashboard has no Discord message; `origin` keeps the two apply paths apart:
-- the Discord click needs a message id match (origin discord), the dashboard Apply needs origin = 'dashboard'.
ALTER TABLE admin_cards ADD COLUMN origin text NOT NULL DEFAULT 'discord' CHECK (origin IN ('discord', 'dashboard'));

-- One-time login links: only the SHA-256 of the 256-bit token is stored (S41, S42).
CREATE TABLE dash_login_tokens (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false
);
CREATE INDEX dash_login_tokens_user_idx ON dash_login_tokens (user_id, created_at);

-- Sessions: only the SHA-256 of the 256-bit session id is stored (S43). Idle 8 h and absolute 24 h are enforced in SQL.
CREATE TABLE dash_sessions (
  sid_hash text PRIMARY KEY,
  user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  role_checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX dash_sessions_user_idx ON dash_sessions (user_id);

-- The one settings panel message of #setting (S37b): buttons are honoured only on this message id.
CREATE TABLE panel_state (
  id text PRIMARY KEY CHECK (id = 'main'),
  channel_id text NOT NULL,
  message_id text NOT NULL,
  posted_at timestamptz NOT NULL DEFAULT now()
);
