-- Plus d'exécution sur le serveur : tout projet tourne dans son conteneur Docker. La colonne runner
-- ('local' | 'docker') n'a plus de sens ; les projets encore en local passent en conteneur.
ALTER TABLE projects DROP COLUMN runner;
