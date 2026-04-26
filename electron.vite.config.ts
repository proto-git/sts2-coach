import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'path';

/**
 * Two renderer entries:
 *   - overlay  — the always-on-top advice panel (src/overlay)
 *   - settings — the config window for keys/model/save dir (src/settings)
 *
 * electron-vite's `renderer` config supports multi-entry via rollupOptions.input.
 * Vite uses the *common parent directory* of the inputs as its `root`, so we
 * point root at `src/` and let each entry resolve via its own subfolder.
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
      },
    },
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@main': resolve(__dirname, 'src/main'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
      },
    },
  },
  renderer: {
    root: 'src',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          overlay:  resolve(__dirname, 'src/overlay/index.html'),
          settings: resolve(__dirname, 'src/settings/index.html'),
        },
      },
    },
  },
});
