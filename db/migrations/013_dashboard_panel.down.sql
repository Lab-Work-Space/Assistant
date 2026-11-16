DROP TABLE IF EXISTS panel_state;
DROP TABLE IF EXISTS dash_sessions;
DROP TABLE IF EXISTS dash_login_tokens;
ALTER TABLE admin_cards DROP COLUMN IF EXISTS origin;
