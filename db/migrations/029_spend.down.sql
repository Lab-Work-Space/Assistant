-- Dropping these forgets the spend history, alert claims and cap overrides (budget_days dept rows are removed with them).
DROP TABLE IF EXISTS spend_overrides;
DROP TABLE IF EXISTS spend_alerts;
DROP TABLE IF EXISTS spend_days;
DELETE FROM budget_days WHERE scope = 'dept';
