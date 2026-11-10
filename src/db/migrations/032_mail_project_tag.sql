-- Project-tagged mail: a developer writes to the owner of a project with #project-name.
-- The system supplies the owner's address (hidden from the developer), CCs the Director,
-- and routes the owner's reply back to the developer.
ALTER TABLE team_mail_sent ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE team_mail ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
