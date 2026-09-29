-- Environnement d'exécution d'un projet : sur le serveur (local) ou dans un conteneur Docker dédié.
ALTER TABLE projects ADD COLUMN runner text NOT NULL DEFAULT 'local' CHECK (runner IN ('local', 'docker'));
ALTER TABLE projects ADD COLUMN runner_config jsonb NOT NULL DEFAULT '{}';   -- { image, memory, cpus }
