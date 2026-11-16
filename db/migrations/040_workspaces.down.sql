DROP TABLE ws_run_counts;
DROP TABLE workspaces;
UPDATE config
SET value = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) <> 'array' OR k <> 'software' THEN v
    ELSE COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements(v) x WHERE NOT (x #>> '{}') = ANY (ARRAY['ws_create','ws_list','ws_read','ws_write','ws_delete','ws_run','ws_export'])), '[]'::jsonb) END)
  FROM jsonb_each(value) AS e(k, v)
), version = version + 1, updated_by = 'migration:040-down'
WHERE key = 'tools.byDept' AND jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb;
