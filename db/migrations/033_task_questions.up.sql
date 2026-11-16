-- ASKBACK-1: a task owner asks its requester one clarifying question (at most 2 per task) and gets an answer instead of guessing or blocking.
-- asker / requester are canonical actor objects: {kind, dept} | {kind, personaId} | {kind, userId} and nothing else (AB11).
-- Every state change is a conditional UPDATE on status (db/repos/questions.ts).
CREATE TABLE task_questions (
  id bigserial PRIMARY KEY,
  task_id text NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  root_id text NOT NULL,
  parent_id text REFERENCES tasks(id) ON DELETE CASCADE,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 2),
  asker jsonb NOT NULL,
  requester jsonb NOT NULL,
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 500),
  question_tainted boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','asked','answered','expired','moot')),
  answer text CHECK (answer IS NULL OR length(answer) BETWEEN 1 AND 1000),
  answer_tainted boolean,
  question_message_id text CHECK (question_message_id ~ '^[0-9]{17,20}$'),
  answer_message_id text CHECK (answer_message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  asked_at timestamptz,
  expires_at timestamptz,
  closed_at timestamptz,
  resumed_at timestamptz,
  CONSTRAINT task_questions_seq_once UNIQUE (task_id, seq),
  CONSTRAINT task_questions_answer CHECK ((status = 'answered') = (answer IS NOT NULL)),
  CONSTRAINT task_questions_closed CHECK ((status IN ('pending','asked')) = (closed_at IS NULL)),
  CONSTRAINT task_questions_asked CHECK (status = 'pending' OR asked_at IS NOT NULL OR status = 'moot'),
  CONSTRAINT task_questions_actors CHECK (
    jsonb_typeof(asker) = 'object' AND jsonb_typeof(requester) = 'object'
    AND asker->>'kind' IN ('head','persona') AND requester->>'kind' IN ('head','persona','human')
  )
);
CREATE UNIQUE INDEX task_questions_one_open ON task_questions (task_id) WHERE status IN ('pending','asked');
CREATE INDEX task_questions_expiry ON task_questions (expires_at) WHERE status = 'asked';
CREATE INDEX task_questions_root ON task_questions (root_id);
CREATE INDEX task_questions_created ON task_questions (created_at);
CREATE INDEX task_questions_parent_open ON task_questions (parent_id) WHERE status IN ('pending','asked');
