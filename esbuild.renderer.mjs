import { build } from 'esbuild';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'es2022',
  format: 'cjs',
  sourcemap: false,
};

await Promise.all([
  // Renderer bundles — no electron imports (all via preload)
  build({
    ...shared,
    entryPoints: ['src/renderer/index.ts'],
    outfile: 'app/dist/renderer.js',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: ['src/hotkey/hotkey.ts'],
    outfile: 'app/dist/hotkey.js',
    external: ['electron'],
  }),
  // Preload scripts — electron is available in preload context
  build({
    ...shared,
    entryPoints: ['src/main/preload.ts'],
    outfile: 'app/dist/main/preload.js',
    external: ['electron'],
  }),
  build({
    ...shared,
    entryPoints: ['src/main/preload-hotkey.ts'],
    outfile: 'app/dist/main/preload-hotkey.js',
    external: ['electron'],
  }),
]);
