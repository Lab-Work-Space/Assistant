-- Task 36: Praw's music queue, volume and paused flag, one row per guild, so the queue survives a restart (restored paused).
-- queue holds [{query, label, requestedBy}]: query is the normalised request (an allowlisted https URL or a search term) and is
-- re-checked against media.ytHostAllowlist before it is ever played. Bounded like the in-memory queue (50 tracks, volume 0-150).
CREATE TABLE music_state (
  guild_id text PRIMARY KEY,
  queue jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(queue) = 'array' AND jsonb_array_length(queue) <= 50),
  volume integer NOT NULL DEFAULT 100 CHECK (volume BETWEEN 0 AND 150),
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
