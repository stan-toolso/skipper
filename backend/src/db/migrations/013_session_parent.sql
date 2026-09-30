-- Une session lancée par un agent (outil MCP `sessions.create`) garde la trace de la session qui l'a créée.
ALTER TABLE sessions ADD COLUMN parent_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL;
CREATE INDEX sessions_parent_idx ON sessions (parent_session_id);
