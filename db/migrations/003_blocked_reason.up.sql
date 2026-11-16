-- R35: why a task is blocked; only 'halt' blocks are resumed automatically (on /resume and boot recovery).
ALTER TABLE tasks ADD COLUMN blocked_reason text CHECK (blocked_reason IN ('halt','approval','budget','turns','error'));
