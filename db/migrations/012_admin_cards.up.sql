-- Admin console (Gate 1 C4-C7): one row per confirmation card Praw's admin run proposed. The row, not the Discord message, is the
-- truth: the validated ops live here (apply reads them from here only), the card is single use (a conditional UPDATE consumes it),
-- and it expires in SQL. `snapshot` is the live state the proposal was built from (the compare-and-swap input at apply).
CREATE TABLE admin_cards (
  seq bigserial PRIMARY KEY,
  id text NOT NULL UNIQUE,                 -- opaque random id (>= 128 bits) carried in the button custom id; it holds no value, op or user
  proposer_id text NOT NULL,               -- the Bot Admin whose run proposed it; only they may press the buttons
  kind text NOT NULL CHECK (kind IN ('config', 'admin_op', 'perm')),
  payload jsonb NOT NULL,                  -- the validated changes / op / perm ops
  snapshot jsonb NOT NULL,
  tainted boolean NOT NULL DEFAULT true,
  channel_id text NOT NULL,
  message_id text,                         -- the hq card message; set after posting
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired', 'superseded')),
  outcome text,                            -- how a confirmed card ended: applied, refused:<why>, failed:<n> ops applied
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by text
);
CREATE INDEX admin_cards_proposer_idx ON admin_cards (proposer_id, status);
