-- Les dépôts hébergés passent à Forgejo (forge open source : pull requests, revues, issues, Actions). Skipper y crée
-- un compte par personne, à la demande, et garde ici la correspondance avec le jeton que ses sessions utilisent pour
-- pousser (chiffré, pour pouvoir le redonner à chaque lancement ; créé par la CLI de Forgejo, l'API ne le permettant
-- pas). Les jetons d'accès du serveur git minimal (046) disparaissent : les personnes gèrent les leurs dans Forgejo.
CREATE TABLE forge_accounts (
  user_id           uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  username          text NOT NULL UNIQUE,
  agent_token       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  token_created_at  timestamptz
);

DROP TABLE git_access_tokens;
