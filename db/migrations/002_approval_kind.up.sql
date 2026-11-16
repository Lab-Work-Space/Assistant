ALTER TABLE approvals ADD COLUMN kind text NOT NULL DEFAULT 'estimate' CHECK (kind IN ('estimate','tree_cap'));
