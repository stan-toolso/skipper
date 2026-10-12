-- Remise à zéro de la conversation « en gardant un résumé » : les derniers échanges de la conversation
-- précédente, transmis au modèle (sans apparaître dans le transcript) avec la première instruction de la
-- conversation neuve, puis effacés.
ALTER TABLE sessions ADD COLUMN resume_digest text;

-- Nettoyage par défaut des planifications : les NOUVELLES planifications repartent d'une conversation neuve
-- à chaque exécution (réglage proposé dans la modale). Les planifications existantes ne sont volontairement
-- pas modifiées ici : la modale de planification propose d'activer ce réglage, après accord de l'utilisateur.
