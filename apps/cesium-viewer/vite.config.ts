import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: __dirname,
  // Cesium static assets (Workers, Assets, Widgets, ThirdParty) are symlinked
  // into public/ from node_modules/cesium/Build/Cesium/
  publicDir: 'public',
  server: {
    fs: {
      allow: [path.resolve(__dirname, '../..')],
    },
    watch: {
      followSymlinks: true,
    },
  },
  optimizeDeps: {
    exclude: ['@spicecraft/core', '@spicecraft/cesium-adapter', '@spicecraft/spice'],
  },
  define: {
    // Cesium looks for this global to find its static assets (Workers, Assets, etc.)
    CESIUM_BASE_URL: JSON.stringify('/'),
  },
});
