-- SKILLS-1 (docs/superpowers/specs/2026-11-08-skills-design.md, Gate 1 docs/security/2026-11-08-gate1-skills.md): per-team skills.
-- Immutable versions, attachments to a department or a persona, head proposals (rows only, never active before a Bot Admin confirms).
CREATE TABLE skills (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  active_version integer NOT NULL CHECK (active_version >= 1),
  owner_dept text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE skill_versions (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 10 AND 2500),
  templates jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(templates) = 'array' AND jsonb_array_length(templates) <= 3),
  tools text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tools) <= 10),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 1 AND 6000),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('admin', 'proposal', 'seed', 'rollback')),
  proposal_id bigint,
  restored_from integer,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
ALTER TABLE skills ADD CONSTRAINT skills_active_version_fk FOREIGN KEY (id, active_version)
  REFERENCES skill_versions (skill_id, version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION skill_versions_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'skill_versions is append-only';
END $$;
CREATE TRIGGER skill_versions_no_change BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_versions_append_only();
CREATE TRIGGER skill_versions_no_truncate BEFORE TRUNCATE ON skill_versions
  FOR EACH STATEMENT EXECUTE FUNCTION skill_versions_append_only();
CREATE TABLE skill_attachments (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (target_kind IN ('dept', 'persona')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  attached_by text NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, target_kind, target_id)
);
CREATE INDEX skill_attachments_target_idx ON skill_attachments (target_kind, target_id);
CREATE TABLE skill_proposals (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'edit')),
  skill_id text NOT NULL CHECK (skill_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  base_version integer NOT NULL DEFAULT 0,
  target_kind text CHECK (target_kind IN ('dept', 'persona')),
  target_id text,
  payload jsonb NOT NULL,
  verdict jsonb NOT NULL,
  tainted boolean NOT NULL DEFAULT false CHECK (tainted = false),
  proposer text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'card', 'applied', 'rejected', 'stale', 'withdrawn')),
  card_id text,
  reviewed_by text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT skill_proposals_create_target CHECK ((kind = 'create') = (target_kind IS NOT NULL AND target_id IS NOT NULL)),
  CONSTRAINT skill_proposals_dept_target CHECK (target_kind IS DISTINCT FROM 'dept' OR target_id = dept_id),
  CONSTRAINT skill_proposals_target_format CHECK (target_id IS NULL OR target_id ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
CREATE UNIQUE INDEX skill_proposals_one_pending ON skill_proposals (skill_id) WHERE status IN ('open', 'card');
CREATE INDEX skill_proposals_dept_idx ON skill_proposals (dept_id, status);
-- Whichever migration lands last writes the full union of kinds (015, 016 and 017 each rewrote the list; 029 and 030 add none).
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code', 'skill'));
