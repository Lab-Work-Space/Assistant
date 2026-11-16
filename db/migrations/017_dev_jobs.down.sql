DROP TABLE IF EXISTS dev_job_bundles;
DROP TABLE IF EXISTS dev_jobs;
DELETE FROM exec_outbox WHERE kind = 'code.result';
ALTER TABLE exec_outbox DROP CONSTRAINT IF EXISTS exec_outbox_kind_check;
ALTER TABLE exec_outbox ADD CONSTRAINT exec_outbox_kind_check CHECK (kind IN ('welcome.post', 'alert', 'summary', 'deploy.result'));
DELETE FROM admin_cards WHERE kind = 'code';
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy'));
