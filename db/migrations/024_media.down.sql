DROP TABLE IF EXISTS media_jobs;
DROP TABLE IF EXISTS media_usage;
-- G2RF5-06: remove the two media tool names from every stored tools.byDept list.
UPDATE config
SET value = (
  SELECT jsonb_object_agg(k, CASE WHEN jsonb_typeof(v) <> 'array' THEN v
    ELSE (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM jsonb_array_elements(v) x WHERE x NOT IN ('"image_generate"'::jsonb, '"video_generate"'::jsonb)) END)
  FROM jsonb_each(value) AS e(k, v)
), version = version + 1, updated_by = 'migration:024:down'
WHERE key = 'tools.byDept' AND jsonb_typeof(value) = 'object' AND value <> '{}'::jsonb;
