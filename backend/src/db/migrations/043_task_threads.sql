-- Tâches en mode conversation (fil à la Slack) : les commentaires deviennent des messages auxquels on répond
-- (un niveau de réponses, comme un fil Slack), que l'on peut mentionner (@personne, @session:<id>) et sur lesquels
-- on réagit par emoji. La description de la tâche est le message d'ouverture du fil : elle reçoit aussi des réactions
-- (comment_id null).

-- Réponse à un autre commentaire : toujours un commentaire racine (une réponse à une réponse est rattachée à la racine).
ALTER TABLE task_comments ADD COLUMN parent_id uuid REFERENCES task_comments (id) ON DELETE CASCADE;
CREATE INDEX task_comments_parent_idx ON task_comments (parent_id);

-- Mentions résolues à l'écriture, dans l'ordre du texte : [{ "kind": "user" | "session", "id", "label", "text" }]
-- (`text` est le fragment du corps qui porte la mention, ex. "@Alice Martin" ou "@session:d8ae4082").
ALTER TABLE task_comments ADD COLUMN mentions jsonb NOT NULL DEFAULT '[]'::jsonb;

-- Réactions (emoji) d'une personne ou d'une session d'agent sur un message du fil ou sur la tâche elle-même.
CREATE TABLE task_reactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     uuid NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
  comment_id  uuid REFERENCES task_comments (id) ON DELETE CASCADE,   -- null : la tâche (message d'ouverture)
  emoji       text NOT NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('human', 'agent')),
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  session_id  uuid REFERENCES sessions (id) ON DELETE CASCADE,
  actor_name  text NOT NULL,                                          -- conservé pour l'affichage
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);
-- Une réaction par acteur, par emoji et par message (ou par tâche).
CREATE UNIQUE INDEX task_reactions_unique_idx
  ON task_reactions (task_id, COALESCE(comment_id, '00000000-0000-0000-0000-000000000000'::uuid), emoji, COALESCE(user_id, session_id));
CREATE INDEX task_reactions_task_idx ON task_reactions (task_id);
CREATE INDEX task_reactions_comment_idx ON task_reactions (comment_id);
