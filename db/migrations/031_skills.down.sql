-- Restores the kind list in force before 031 (017's list; 029 and 030 added no kind).
DELETE FROM admin_cards WHERE kind = 'skill';
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code'));
DROP TABLE skill_proposals;
DROP TABLE skill_attachments;
DROP TRIGGER skill_versions_no_truncate ON skill_versions;
DROP TRIGGER skill_versions_no_change ON skill_versions;
ALTER TABLE skills DROP CONSTRAINT skills_active_version_fk;
DROP TABLE skill_versions;
DROP FUNCTION skill_versions_append_only();
DROP TABLE skills;
