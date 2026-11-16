ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_pin;
-- The narrower reason list has no config_changed: such a row stays quarantined (it still needs a re-add and re-approval), only its reason is mapped.
UPDATE mcp_servers SET quarantine_reason = 'snapshot_changed' WHERE quarantine_reason = 'config_changed';
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_quarantine_reason_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_quarantine_reason_check CHECK (quarantine_reason IS NULL OR quarantine_reason IN ('snapshot_changed'));
ALTER TABLE mcp_servers DROP COLUMN approved_config_sha256;
