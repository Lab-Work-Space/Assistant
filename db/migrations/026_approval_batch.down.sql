-- B13: drain first (decide the pending batched approvals, or wait for expiry), then migrate down. Old code answers
-- "Unknown action." on leftover batch buttons.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM approvals WHERE batch_id IS NOT NULL AND status = 'pending') THEN
    RAISE EXCEPTION 'approval batches still have pending approvals; decide them or wait for expiry, then migrate down';
  END IF;
END $$;
DROP TRIGGER IF EXISTS approvals_batch_id_immutable ON approvals;
DROP FUNCTION IF EXISTS approvals_batch_id_immutable();
DROP INDEX IF EXISTS approvals_batch_idx;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_batch_kind_check;
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_batch_fk;
ALTER TABLE approvals DROP COLUMN IF EXISTS batch_id;
DROP TABLE IF EXISTS approval_batches;
