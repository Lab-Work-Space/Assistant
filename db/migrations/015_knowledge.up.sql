-- Self-updating knowledge (self-development part 2; Gate 1 K1-K18).

-- Department notes: pinned, tainted (G2-04 provenance, sticky), where the note came from, and a normalised-text hash for the duplicate check.
-- Notes that predate this column were written without taint tracking: they count as tainted (fail safe), as in 011; the default is dropped so every writer says.
ALTER TABLE dept_notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;
ALTER TABLE dept_notes ADD COLUMN tainted boolean NOT NULL DEFAULT true;
ALTER TABLE dept_notes ALTER COLUMN tainted DROP DEFAULT;
ALTER TABLE dept_notes ADD COLUMN source text NOT NULL DEFAULT 'task' CHECK (source IN ('task', 'reflect', 'manual'));
ALTER TABLE dept_notes ADD COLUMN norm_hash text;
CREATE INDEX dept_notes_hash_idx ON dept_notes (dept_id, norm_hash);
CREATE INDEX dept_notes_source_idx ON dept_notes (dept_id, source, created_at);

-- K10: prompt_overrides becomes append-only. "Active" is the newest row of a ref; a tombstone row means "the file default".
-- Rows that were switched off by the old delete() get a tombstone on top, so they stay off.
ALTER TABLE prompt_overrides ADD COLUMN tombstone boolean NOT NULL DEFAULT false;
ALTER TABLE prompt_overrides ADD COLUMN restored_from bigint;
INSERT INTO prompt_overrides (ref, body, version, created_by, active, tombstone)
  SELECT p.ref, '', p.version + 1, 'system:015', true, true FROM prompt_overrides p
  WHERE p.version = (SELECT max(version) FROM prompt_overrides q WHERE q.ref = p.ref) AND NOT p.active;
CREATE UNIQUE INDEX prompt_overrides_ref_version_uq ON prompt_overrides (ref, version);
CREATE FUNCTION prompt_overrides_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'prompt_overrides is append-only';
END $$;
CREATE TRIGGER prompt_overrides_no_change BEFORE UPDATE OR DELETE ON prompt_overrides
  FOR EACH ROW EXECUTE FUNCTION prompt_overrides_append_only();

-- G2K-01: a lesson made from a tainted proposal stays tainted (sticky). Existing lessons were written or switched on by people.
ALTER TABLE lessons ADD COLUMN tainted boolean NOT NULL DEFAULT false;

-- A new card family; the proposal behind it lives in kb_proposals.
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge'));

-- The knowledge base: versioned markdown per department or company-wide. Model-written, human-confirmed; `tainted` is sticky.
CREATE TABLE kb_docs (
  id bigserial PRIMARY KEY,
  scope text NOT NULL,                       -- a department id or 'company'
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) <= 20000),
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  sources jsonb NOT NULL DEFAULT '[]',
  tainted boolean NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  fts tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || body)) STORED
);
CREATE INDEX kb_docs_scope_idx ON kb_docs (scope, status);
CREATE INDEX kb_docs_fts_idx ON kb_docs USING gin (fts);
CREATE TABLE kb_versions (
  id bigserial PRIMARY KEY,
  doc_id bigint NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  sources jsonb NOT NULL DEFAULT '[]',
  tainted boolean NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (doc_id, version)
);

-- A proposal waits here until a Bot Admin mints a card for it from the dashboard (the card is proposer-bound and single use).
CREATE TABLE kb_proposals (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL,                     -- the proposing department (also the scope owner)
  kind text NOT NULL CHECK (kind IN ('kb_create', 'kb_edit', 'kb_archive', 'kb_purge', 'note_promote', 'note_pin', 'lesson_edit', 'lesson_retire', 'prompt_set', 'prompt_rollback')),
  ref text,                                  -- prompt ref (prompt kinds only)
  payload jsonb NOT NULL,
  base_version integer NOT NULL DEFAULT 0,   -- compare-and-swap input: the doc or prompt version the proposal was written against
  tainted boolean NOT NULL,                  -- computed by code from the sources and the proposing run, never from the model
  sources jsonb NOT NULL DEFAULT '[]',
  proposer text NOT NULL,                    -- actor key, e.g. head:software
  via text NOT NULL CHECK (via IN ('tool', 'weekly', 'dashboard')),
  verdict jsonb,                             -- lint and classifier result (prompt kinds)
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'card', 'applied', 'rejected', 'stale', 'withdrawn')),
  reviewed_by text,                          -- K3: the Bot Admin who read the tainted sources (second step)
  reviewed_at timestamptz,
  card_id text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  -- K5 (also in the repo): only a head text or a member prompt can be named, and a head text only by its own department
  CONSTRAINT kb_proposals_ref_check CHECK (ref IS NULL OR (ref ~ '^(heads|members)/[a-z0-9-]+$' AND (ref NOT LIKE 'heads/%' OR ref = 'heads/' || dept_id)))
);
CREATE INDEX kb_proposals_dept_idx ON kb_proposals (dept_id, status);
-- K8c: at most one pending prompt proposal per ref.
CREATE UNIQUE INDEX kb_proposals_one_prompt_pending ON kb_proposals (ref) WHERE kind IN ('prompt_set', 'prompt_rollback') AND status IN ('open', 'card');

-- Idempotence: reflect runs once per task (the claim), the weekly review once per department and week.
CREATE TABLE kb_reflections (
  task_id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE kb_review_runs (
  dept_id text NOT NULL,
  week text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dept_id, week)
);
