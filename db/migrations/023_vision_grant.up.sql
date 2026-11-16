-- RFMD P2 (docs/security/2026-11-03-gate1-rfmd.md RF14): every department holds the `vision` grant (the read_image tool) by default. A stored
-- tools.byDept replaces the code default, so add the name to each stored department list that lacks it. Data only; no schema change.
-- A list already at the schema limit (100) is left alone so the row never fails validation (Gate 2 L-1).
UPDATE config
SET value = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) <> 'array' THEN v WHEN v ? 'read_image' THEN v WHEN jsonb_array_length(v) >= 100 THEN v ELSE v || '["read_image"]'::jsonb END)
  FROM jsonb_each(value) AS e(k, v)
), version = version + 1, updated_by = 'migration:023'
WHERE key = 'tools.byDept' AND jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb;
