-- Activité d'une session en cours : 'busy' (l'agent travaille) ou 'idle' (en attente d'instructions).
ALTER TABLE sessions ADD COLUMN activity text CHECK (activity IN ('busy', 'idle'));
