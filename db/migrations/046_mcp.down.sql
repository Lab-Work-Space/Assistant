DELETE FROM config WHERE key IN ('mcp.enabled','mcp.maxCallsPerTree','mcp.maxCallsPerDay');
DROP TABLE mcp_call_counts;
DROP TABLE mcp_server_depts;
DROP TABLE mcp_servers;
