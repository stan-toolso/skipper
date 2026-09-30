-- Plusieurs comptes Google par projet : chaque compte a son identifiant ; un même compte Google
-- (google_sub) n'est relié qu'une fois à un projet (le reconnecter met à jour ses accès).
ALTER TABLE project_google_accounts ADD COLUMN id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE project_google_accounts DROP CONSTRAINT project_google_accounts_pkey;
ALTER TABLE project_google_accounts ADD PRIMARY KEY (id);
ALTER TABLE project_google_accounts ADD CONSTRAINT project_google_accounts_project_sub_key UNIQUE (project_id, google_sub);
