import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  envDir: '..',
  // host: true expose le serveur de dev sur le réseau local (test depuis un autre appareil).
  server: { port: 5173, host: true },
});
