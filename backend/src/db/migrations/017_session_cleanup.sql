-- Réglages de nettoyage automatique d'une session (utile aux sessions planifiées, dont l'historique grossit sans fin) :
--   { retentionDays?: number, contextAction?: 'compact' | 'reset', contextMaxTokens?: number }
-- retentionDays : les événements du transcript plus vieux que N jours sont supprimés ;
-- contextAction : quand le contexte de l'agent dépasse contextMaxTokens, compacter la conversation (/compact)
--                 ou repartir d'une conversation neuve (external_id remis à null).
ALTER TABLE sessions ADD COLUMN cleanup jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Taille du contexte de l'agent au dernier tour (tokens d'entrée du dernier appel au modèle), null si inconnue.
ALTER TABLE sessions ADD COLUMN context_tokens integer;
