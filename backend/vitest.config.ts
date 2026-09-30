import { defineConfig } from 'vitest/config';

/**
 * Tests unitaires et d'intégration du backend (`src/**\/*.test.ts`, exclus du build).
 * Les tests qui ont besoin de PostgreSQL lisent TEST_DATABASE_URL et sont ignorés sans elle
 * (obligatoires en CI).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Chaque fichier a son propre processus : variables d'environnement et modules isolés.
    pool: 'forks',
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
