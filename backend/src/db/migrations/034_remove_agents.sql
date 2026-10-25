-- Fin de la notion d'agents : les appels directs de modèle sont désormais des nœuds « appel de modèle »
-- (callLlm) des workflows, les sessions dédiées des nœuds « tâche » ou « session ». Les tables des agents et
-- de leurs exécutions disparaissent avec les colonnes qui les référençaient.

-- Les nœuds « agent » d'un graphe n'existent plus : retirés des définitions, avec les arêtes qui les touchaient
-- (en production il n'y en avait aucun ; par sécurité pour toute autre installation).
UPDATE workflows w
SET definition = jsonb_build_object(
  'nodes', COALESCE((SELECT jsonb_agg(n) FROM jsonb_array_elements(w.definition->'nodes') n WHERE n->>'type' <> 'agent'), '[]'::jsonb),
  'edges', COALESCE((
    SELECT jsonb_agg(e) FROM jsonb_array_elements(w.definition->'edges') e
    WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(w.definition->'nodes') n WHERE n->>'type' = 'agent' AND n->>'key' IN (e->>'source', e->>'target'))
  ), '[]'::jsonb)
), updated_at = now()
WHERE definition->'nodes' @> '[{"type": "agent"}]'::jsonb;

ALTER TABLE workflow_run_nodes DROP COLUMN IF EXISTS agent_run_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS agent_run_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS agent_id;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agents;
