-- Les agents tournent en conteneur : l'accès « shell de la session » aux connexions (agent SSH, tunnels,
-- variables d'environnement) n'existe plus. Toute connexion passe par les outils du serveur MCP
-- `connections` ; la colonne exposure (mcp | direct | both) n'a plus de sens.
ALTER TABLE connections DROP COLUMN exposure;
