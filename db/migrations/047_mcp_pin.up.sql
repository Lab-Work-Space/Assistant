-- R6 MCP-1 Gate 2 residual 4: pin the approved config. Additive. The column holds the full MC-C8 hash (sha256 hex of image id, command, env, class, sorted
-- departments and snapshot hash) as the Bot Admin approved it; the host and the tool adapter recompute it and refuse a row that no longer matches.
ALTER TABLE mcp_servers ADD COLUMN approved_config_sha256 text CONSTRAINT mcp_servers_approved_config_sha256_check CHECK (approved_config_sha256 IS NULL OR approved_config_sha256 ~ '^[0-9a-f]{64}$');
-- An active row written before this migration holds no pin and nothing proves what was approved, so it goes back to pending (it must be approved again). None exists live.
UPDATE mcp_servers SET status = 'pending', approved_by = NULL, approved_at = NULL, updated_at = now() WHERE status = 'active';
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_pin CHECK (status <> 'active' OR approved_config_sha256 IS NOT NULL);
ALTER TABLE mcp_servers DROP CONSTRAINT mcp_servers_quarantine_reason_check;
ALTER TABLE mcp_servers ADD CONSTRAINT mcp_servers_quarantine_reason_check CHECK (quarantine_reason IS NULL OR quarantine_reason IN ('snapshot_changed','config_changed'));
