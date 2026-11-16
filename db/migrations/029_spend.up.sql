-- SPEND-1: spend rollup (per local day, dept, provider, model, tool, root), alert claims, and department cap overrides.
-- 999999.99 is SPEND_MAX_USD (governance/spend.ts): the largest value every money column and config key may hold (numeric(12,6) tops out at 999999.999999, SP-01).
CREATE TABLE spend_days (
  day date NOT NULL,
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z0-9._:-]{1,64}$'),
  model text NOT NULL DEFAULT '' CHECK (model = '' OR model ~ '^[\x21-\x7e]{1,128}$'),
  tool text NOT NULL CHECK (tool ~ '^[a-z0-9_]{1,40}$'),
  root_id text NOT NULL DEFAULT '',
  spent_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (day, dept_id, provider, model, tool, root_id)
);
CREATE INDEX spend_days_dept_day_idx ON spend_days (dept_id, day);

CREATE TABLE spend_alerts (
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(W[0-9]{2}|[0-9]{2}(-[0-9]{2})?)$'),
  kind text NOT NULL CHECK (kind IN ('warn','stop','anomaly','projection','summary')),
  scope_id text NOT NULL CHECK (length(scope_id) <= 32),
  detail jsonb,
  attempts integer NOT NULL DEFAULT 0,
  posted_at timestamptz,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, kind, scope_id)
);

CREATE TABLE spend_overrides (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  old_cap_usd numeric(12,6) NOT NULL CHECK (old_cap_usd >= 0 AND old_cap_usd <= 999999.99),
  new_cap_usd numeric(12,6) NOT NULL CHECK (new_cap_usd > old_cap_usd AND new_cap_usd <= 999999.99),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  channel_id text NOT NULL,
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz
);
CREATE UNIQUE INDEX spend_overrides_one_pending ON spend_overrides (dept_id, month) WHERE status = 'pending';
CREATE INDEX spend_overrides_approved_idx ON spend_overrides (dept_id, month) WHERE status = 'approved';

-- Best-effort history: department per UTC day from budget_days (bot + warroom_bot); provider and tool are 'unknown' (SP-07: the dept id is checked by the same regex as the column).
INSERT INTO spend_days (day, dept_id, provider, model, tool, root_id, spent_usd, calls)
SELECT d.day, d.dept_id, 'unknown', '', 'unknown', '', sum(d.spent_usd), 0
FROM (
  SELECT b.day, b.spent_usd,
         CASE WHEN x.dept ~ '^[a-z_]{1,32}$' THEN x.dept ELSE '_unattributed' END AS dept_id
  FROM budget_days b
  LEFT JOIN personas p ON b.scope_id = 'persona:' || p.id
  CROSS JOIN LATERAL (SELECT coalesce(CASE WHEN b.scope_id LIKE 'head:%' THEN substr(b.scope_id, 6) END, p.dept_id, '_unattributed') AS dept) x
  WHERE b.scope IN ('bot', 'warroom_bot') AND b.spent_usd > 0 AND b.day >= current_date - 60
) d
GROUP BY d.day, d.dept_id;

-- SP-08: the enforced month-to-date (the dept row) starts from the same history, so a cap set mid-month sees the real figure (UTC month; at most one day off the local month).
INSERT INTO budget_days (day, scope, scope_id, spent_usd)
SELECT date_trunc('month', current_date)::date, 'dept', dept_id, sum(spent_usd)
FROM spend_days WHERE day >= date_trunc('month', current_date)::date
GROUP BY dept_id
ON CONFLICT DO NOTHING;
