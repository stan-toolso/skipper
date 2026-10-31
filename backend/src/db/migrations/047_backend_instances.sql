-- Mises à jour sans interruption (bleu/vert) : plusieurs instances du backend peuvent tourner en même temps sur la
-- cellule, l'ancienne se vidant (drainage) pendant que la nouvelle reçoit le trafic. Chaque instance s'inscrit dans
-- `backend_instances` et y bat toutes les cinq secondes ; elle s'en retire en s'arrêtant. Une instance dont le battement
-- est vieux de plus de trente secondes (ou dont le processus n'existe plus) est morte : ce qu'elle tenait est repris.
-- `token` authentifie les appels internes entre instances (HTTP sur le port de l'instance, jamais exposé par nginx).
CREATE TABLE backend_instances (
  id              uuid PRIMARY KEY,
  port            integer NOT NULL,
  pid             integer NOT NULL,
  label           text NOT NULL DEFAULT '',
  token           text NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  heartbeat_at    timestamptz NOT NULL DEFAULT now(),
  draining_since  timestamptz
);

-- Instance qui tient le processus d'une session en cours (NULL : aucune). Pas de clé étrangère : la ligne de l'instance
-- disparaît à son arrêt, la session est alors reprise ou interrompue par une autre.
-- `parked_at` : session « garée » par une instance en drainage à la fin de son tour (processus arrêté, conversation
-- intacte, statut `running`/`idle` conservé) ; la première instruction la relance sur l'instance qui la reçoit.
ALTER TABLE sessions ADD COLUMN instance_id uuid, ADD COLUMN parked_at timestamptz;
CREATE INDEX sessions_instance_idx ON sessions (instance_id) WHERE status = 'running';

-- Instance qui tient le shell d'un terminal ouvert.
ALTER TABLE terminals ADD COLUMN instance_id uuid;
