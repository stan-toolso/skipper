import { defineConfig } from 'vitest/config';

/**
 * Tests du frontend (`src/**\/*.test.{ts,tsx}`) : fonctions pures et rendu statique de composants, sans navigateur. Configuration séparée
 * de vite.config.ts pour ne pas charger les plugins React et PWA.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
