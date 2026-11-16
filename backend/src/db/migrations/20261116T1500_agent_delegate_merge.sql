-- ---- Agents de projet : fusion permise sur un compte git prêté en écriture ------------------------------------------
-- Prêté en écriture (push et pull requests), un compte GitHub ou GitLab peut en plus permettre à l'agent de fusionner
-- les pull requests (merge requests) du projet avec ce compte, par `tasks.pr_merge`, sans demander l'accord d'une
-- personne à chaque fois. Sans effet sur un prêt en lecture seule.
ALTER TABLE agent_profiles ADD COLUMN github_delegate_merge boolean NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN gitlab_delegate_merge boolean NOT NULL DEFAULT false;
