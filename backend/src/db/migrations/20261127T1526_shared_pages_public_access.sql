-- Page partagée ouverte à tout le monde, sans connexion : quiconque a le lien /shared/<id> la lit
-- (contenu servi par /api/shared/<id>, sans commentaires ni sources graphql vivantes). Implique link_access.
ALTER TABLE shared_pages ADD COLUMN IF NOT EXISTS public_access boolean NOT NULL DEFAULT false;
