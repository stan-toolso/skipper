-- Notifications de demandes : marquées lues quand la demande est réglée.
-- Les notifications créées avant cette version n'ont pas de requestId dans payload : on marque lues
-- celles dont la session n'a plus aucune demande en attente.
UPDATE notifications n SET read_at = now()
WHERE n.type = 'request.created' AND n.read_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.session_id = n.session_id AND r.status = 'pending');

CREATE INDEX notifications_request_idx ON notifications ((payload->>'requestId')) WHERE type = 'request.created';
