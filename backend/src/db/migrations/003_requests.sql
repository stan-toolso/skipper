-- Demandes d'intervention humaine émises par une session (autorisation d'outil, question, ...).
CREATE TYPE request_status AS ENUM ('pending', 'answered', 'cancelled', 'expired');

CREATE TABLE requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  type        text NOT NULL,                     -- 'permission', 'question', 'input', ...
  status      request_status NOT NULL DEFAULT 'pending',
  title       text NOT NULL,
  message     text,
  payload     jsonb NOT NULL DEFAULT '{}',       -- données propres au type (outil, options...)
  response    jsonb,                             -- réponse de l'humain
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE INDEX requests_session_idx ON requests (session_id, created_at);
CREATE INDEX requests_pending_idx ON requests (created_at) WHERE status = 'pending';
