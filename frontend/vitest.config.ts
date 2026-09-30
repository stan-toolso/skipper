import { defineConfig } from 'vitest/config';

/**
 * Tests du frontend (`src/**\/*.test.ts`) : fonctions pures, sans navigateur. Configuration séparée
 * de vite.config.ts pour ne pas charger les plugins React et PWA.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
