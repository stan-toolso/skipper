-- Notifications Web Push : un abonnement par appareil et par utilisateur. La paire de clés VAPID est
-- générée une fois et rangée dans app_settings (clé push.vapid, clé privée chiffrée).
CREATE TABLE push_subscriptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint     text NOT NULL UNIQUE,          -- URL du service de push de l'appareil
  keys         text NOT NULL,                 -- JSON { p256dh, auth } chiffré
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error   text
);
CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
