-- OT-1: overtime requests. Code raises one request per task tree per off day (a card in #setting); a Bot Admin approves overtime for that one tree
-- (or opens the whole day). An approved row IS the grant: the caps are snapshotted into it and consumed by one conditional UPDATE
-- (db/repos/ot-requests.ts), so runs and money cannot overshoot through concurrency (the row CHECKs are a second line).
CREATE TABLE ot_requests (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  local_day date NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 5),
  -- the person whose request started the tree (a Discord user id; the per-person daily cap keys on it)
  requested_by text NOT NULL CHECK (char_length(requested_by) BETWEEN 1 AND 64),
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{12}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','workday','expired','moot')),
  card_channel_id text CHECK (card_channel_id IS NULL OR card_channel_id ~ '^[0-9]{17,20}$'),
  card_message_id text CHECK (card_message_id IS NULL OR card_message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^[0-9]{17,20}$'),
  decided_at timestamptz,
  grant_expires_at timestamptz,
  max_runs integer CHECK (max_runs IS NULL OR max_runs BETWEEN 1 AND 200),
  runs_used integer NOT NULL DEFAULT 0 CHECK (runs_used >= 0),
  max_usd numeric(10,4) CHECK (max_usd IS NULL OR (max_usd > 0 AND max_usd <= 50)),
  usd_base numeric(12,6) CHECK (usd_base IS NULL OR usd_base >= 0),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded','root_ended')),
  CONSTRAINT ot_requests_day_seq UNIQUE (root_id, local_day, seq),
  CONSTRAINT ot_requests_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '25 hours'),
  CONSTRAINT ot_requests_decided CHECK (status IN ('pending','expired','moot') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT ot_requests_grant CHECK ((status = 'approved') = (grant_expires_at IS NOT NULL AND max_runs IS NOT NULL AND max_usd IS NOT NULL AND usd_base IS NOT NULL)),
  CONSTRAINT ot_requests_grant_window CHECK (grant_expires_at IS NULL OR (grant_expires_at > decided_at AND grant_expires_at <= decided_at + interval '12 hours')),
  CONSTRAINT ot_requests_runs_cap CHECK (max_runs IS NULL OR runs_used <= max_runs),
  CONSTRAINT ot_requests_runs_only_grant CHECK (runs_used = 0 OR status = 'approved'),
  CONSTRAINT ot_requests_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT ot_requests_revoke_only_grant CHECK (revoked_at IS NULL OR status = 'approved')
);
CREATE UNIQUE INDEX ot_requests_one_pending_idx ON ot_requests(root_id) WHERE status = 'pending';
CREATE UNIQUE INDEX ot_requests_one_live_idx ON ot_requests(root_id) WHERE status = 'approved' AND revoked_at IS NULL;
CREATE INDEX ot_requests_card_idx ON ot_requests(card_message_id) WHERE card_message_id IS NOT NULL;
-- OT-C9: the global and per-person daily counts
CREATE INDEX ot_requests_day_idx ON ot_requests(local_day, requested_by);
