-- Pull requests suivies : deux élargissements.
--
-- 1. Une PR peut appartenir à un autre dépôt GitHub que celui du projet : une session peut ouvrir ou déclarer une PR
--    sur n'importe quel dépôt (clone d'un autre projet dans son dossier de travail, dépôt d'une dépendance…).
--    `repo` est le « owner/name » GitHub de la PR ; les lignes existantes reçoivent celui du dépôt du projet (vide pour
--    un projet sans dépôt GitHub). Le numéro n'est unique que dans un dépôt.
--
-- 2. Une PR « en préparation » (status = 'pending') existe dès qu'une work session (branche) porte des modifications
--    (commits en avance sur la base ou fichiers non commités), avant toute ouverture sur GitHub : elle n'a ni numéro ni
--    URL, est rattachée à sa work session et garde un instantané du travail local. Quand la PR est ouverte sur GitHub,
--    la même ligne reçoit son numéro et passe à 'open' (identifiant, note et tâche conservés).
ALTER TABLE pull_requests ADD COLUMN repo text NOT NULL DEFAULT '';

UPDATE pull_requests pr
SET repo = sub.repo
FROM (
  SELECT id,
         CASE
           WHEN u ~* '^https?://([^@/]+@)?(www\.)?github\.com/[^/]+/[^/]+$' THEN regexp_replace(u, '^https?://([^@/]+@)?(www\.)?github\.com/([^/]+)/([^/]+)$', '\3/\4', 'i')
           WHEN u ~* '^(ssh://)?git@github[A-Za-z0-9._-]*[:/][^/]+/[^/]+$' THEN regexp_replace(u, '^(ssh://)?git@github[A-Za-z0-9._-]*[:/]([^/]+)/([^/]+)$', '\2/\3', 'i')
           ELSE ''
         END AS repo
  FROM (SELECT id, regexp_replace(regexp_replace(COALESCE(git_url, ''), '/+$', ''), '\.git$', '', 'i') AS u FROM projects) p
) sub
WHERE pr.project_id = sub.id;

ALTER TABLE pull_requests DROP CONSTRAINT pull_requests_project_id_number_key;
ALTER TABLE pull_requests ALTER COLUMN number DROP NOT NULL;
CREATE UNIQUE INDEX pull_requests_repo_number_idx ON pull_requests (project_id, lower(repo), number) WHERE number IS NOT NULL;

ALTER TABLE pull_requests DROP CONSTRAINT pull_requests_status_check;
ALTER TABLE pull_requests ADD CONSTRAINT pull_requests_status_check CHECK (status IN ('pending', 'open', 'merged', 'closed'));
-- Une PR en préparation n'a pas de numéro ; toute autre en a un.
ALTER TABLE pull_requests ADD CONSTRAINT pull_requests_number_check CHECK ((status = 'pending') = (number IS NULL));
-- Work session (branche) dont la PR suit le travail ; une seule PR en préparation par work session.
ALTER TABLE pull_requests ADD COLUMN worksession_id uuid REFERENCES worksessions (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX pull_requests_pending_worksession_idx ON pull_requests (worksession_id) WHERE status = 'pending';
CREATE INDEX pull_requests_worksession_idx ON pull_requests (worksession_id);
-- Travail local constaté à la dernière synchronisation : commits en avance sur la base, fichiers non commités.
ALTER TABLE pull_requests ADD COLUMN local_commits integer;
ALTER TABLE pull_requests ADD COLUMN local_changes integer;
