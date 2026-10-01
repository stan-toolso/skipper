-- File d'attente des sessions : au-delà du nombre maximal de sessions simultanées (global ou par projet),
-- une session qui devrait démarrer passe à « queued » et démarre dès qu'une place se libère, dans l'ordre
-- d'arrivée. queued_start garde l'instruction de démarrage ({ message, attachments }, null : la consigne
-- de la session) pour survivre à un redémarrage du serveur.
ALTER TYPE session_status ADD VALUE IF NOT EXISTS 'queued';
ALTER TABLE sessions
  ADD COLUMN queued_at    timestamptz,
  ADD COLUMN queued_start jsonb;
