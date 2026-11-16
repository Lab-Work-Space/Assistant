-- WEBGRANT-1 (TASKWEB-1): one approval per task tree for read-only web reading (fetch_page). One row is one grant; the caps are
-- snapshotted from config when the grant is made and consumed by one conditional UPDATE (db/repos/web-grants.ts), so they cannot overshoot.
CREATE TABLE web_grants (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  approval_id bigint NOT NULL UNIQUE REFERENCES approvals(id),
  granted_by text NOT NULL CHECK (granted_by ~ '^[0-9]{17,20}$'),
  requested_by text NOT NULL,
  max_fetches integer NOT NULL CHECK (max_fetches BETWEEN 1 AND 200),
  max_hosts integer NOT NULL CHECK (max_hosts BETWEEN 1 AND 50),
  max_url_chars integer NOT NULL CHECK (max_url_chars BETWEEN 500 AND 20000),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  url_chars_used integer NOT NULL DEFAULT 0 CHECK (url_chars_used >= 0),
  hosts text[] NOT NULL DEFAULT '{}',
  -- W-C11(b): the card message this grant was made on; the revoke button edits only that message
  card_message_id text CHECK (card_message_id IS NULL OR card_message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded')),
  CONSTRAINT web_grants_used_cap CHECK (used <= max_fetches),
  CONSTRAINT web_grants_hosts_cap CHECK (cardinality(hosts) <= max_hosts),
  CONSTRAINT web_grants_chars_cap CHECK (url_chars_used <= max_url_chars),
  CONSTRAINT web_grants_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT web_grants_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- W-C8: at most one unrevoked row per task tree (live or not); a new grant first supersedes every unrevoked row.
CREATE UNIQUE INDEX web_grants_one_live_idx ON web_grants(root_id) WHERE revoked_at IS NULL;
CREATE INDEX web_grants_card_idx ON web_grants(card_message_id) WHERE card_message_id IS NOT NULL;
