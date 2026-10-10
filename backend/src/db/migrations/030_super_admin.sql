-- Super administrateur : administrateur de l'application qui administre aussi tous les projets, membre ou non.
ALTER TABLE users ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false;

-- Le plus ancien administrateur devient le premier super administrateur.
UPDATE users SET is_super_admin = true
WHERE id = (SELECT id FROM users WHERE is_admin ORDER BY created_at, id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE is_super_admin);
UPDATE users SET is_admin = true WHERE is_super_admin AND NOT is_admin;
