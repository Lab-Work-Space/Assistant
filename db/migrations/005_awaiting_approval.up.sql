-- The approval a task in awaiting_approval waits on: its own request, or the pending cap approval of its tree that
-- it joined (R20). Decisions, expiry and resumeApproved release or block only the tasks waiting on that approval,
-- so a USD tree-cap decision never touches waiters of a local-cap approval and vice versa.
ALTER TABLE tasks ADD COLUMN awaiting_approval_id bigint REFERENCES approvals(id) ON DELETE SET NULL;
CREATE INDEX tasks_awaiting_approval_idx ON tasks(awaiting_approval_id) WHERE awaiting_approval_id IS NOT NULL;
