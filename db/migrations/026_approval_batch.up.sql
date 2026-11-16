-- APPROVAL-BATCH-1: one Discord card for several tool approvals of one task and one requester. Each item stays its own
-- approvals row (own decision, own input_sha256 re-checked at claim time); a batch only groups how they are shown and decided.
CREATE TABLE approval_batches (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id),
  requested_by text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','sealed','posted','dissolved','closed')),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count BETWEEN 0 AND 8),
  -- first 12 hex of sha256 over the ascending "<id>:<input_sha256>" list (B5); set before any exit from 'open'
  items_digest text CHECK (items_digest IS NULL OR items_digest ~ '^[0-9a-f]{12}$'),
  channel_id text CHECK (channel_id IS NULL OR channel_id ~ '^[0-9]{17,20}$'),
  message_id text CHECK (message_id IS NULL OR message_id ~ '^[0-9]{17,20}$'),
  opened_at timestamptz NOT NULL DEFAULT now(),
  sealed_at timestamptz,
  posted_at timestamptz,
  CONSTRAINT approval_batches_digest_check CHECK (state = 'open' OR items_digest IS NOT NULL),
  CONSTRAINT approval_batches_member_key UNIQUE (id, task_id, requested_by)
);
CREATE UNIQUE INDEX approval_batches_open_idx ON approval_batches(task_id, requested_by) WHERE state = 'open';
CREATE INDEX approval_batches_unposted_idx ON approval_batches(state) WHERE state IN ('open','sealed');

ALTER TABLE approvals ADD COLUMN batch_id bigint;
-- B4: a member belongs to a batch of its own task and requester (MATCH SIMPLE: NULL batch_id is not checked); NO ACTION on delete.
ALTER TABLE approvals ADD CONSTRAINT approvals_batch_fk FOREIGN KEY (batch_id, task_id, requested_by)
  REFERENCES approval_batches(id, task_id, requested_by);
ALTER TABLE approvals ADD CONSTRAINT approvals_batch_kind_check CHECK (batch_id IS NULL OR kind = 'tool');
CREATE INDEX approvals_batch_idx ON approvals(batch_id) WHERE batch_id IS NOT NULL;

-- B4: batch_id never changes once set (no re-pointing, no clearing).
CREATE FUNCTION approvals_batch_id_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.batch_id IS NOT NULL AND NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    RAISE EXCEPTION 'approvals.batch_id is immutable once set (approval %)', OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER approvals_batch_id_immutable BEFORE UPDATE OF batch_id ON approvals
  FOR EACH ROW EXECUTE FUNCTION approvals_batch_id_immutable();
