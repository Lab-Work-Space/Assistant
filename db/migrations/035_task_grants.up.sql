-- TREEGRANT-1: "Approve the whole task". One approval per task tree for a fixed allow-list of internal write tools (tools/tree-grant-scope.ts).
-- One row is one grant; the call cap is snapshotted from config when the grant is made and consumed by one conditional UPDATE
-- (db/repos/task-grants.ts), so it cannot overshoot. `used_by_tool` is written only by that UPDATE, with a registered tool name as the key.
CREATE TABLE task_grants (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  approval_id bigint NOT NULL UNIQUE REFERENCES approvals(id),
  granted_by text NOT NULL CHECK (granted_by ~ '^[0-9]{17,20}$'),
  requested_by text NOT NULL,
  max_calls integer NOT NULL CHECK (max_calls BETWEEN 1 AND 500),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  used_by_tool jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(used_by_tool) = 'object'),
  -- TG-C10: the companion web grant (made on the same click) is revoked with this one; it never carries a card id of its own
  web_grant_id bigint REFERENCES web_grants(id),
  card_message_id text CHECK (card_message_id IS NULL OR card_message_id ~ '^[0-9]{17,20}$'),
  card_channel_id text CHECK (card_channel_id IS NULL OR card_channel_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded','disabled','root_ended')),
  CONSTRAINT task_grants_used_cap CHECK (used <= max_calls),
  CONSTRAINT task_grants_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '72 hours'),
  CONSTRAINT task_grants_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- At most one unrevoked row per task tree (live or not); a new grant first supersedes every unrevoked row (inside the root lock).
CREATE UNIQUE INDEX task_grants_one_live_idx ON task_grants(root_id) WHERE revoked_at IS NULL;
CREATE INDEX task_grants_card_idx ON task_grants(card_message_id) WHERE card_message_id IS NOT NULL;
