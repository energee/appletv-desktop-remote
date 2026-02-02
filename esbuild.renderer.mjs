import { build } from 'esbuild';

const shared = {
    bundle: true,
    platform: 'node',
    target: 'es2022',
    format: 'cjs',
    external: ['electron', '@electron/remote'],
    sourcemap: false,
};

await Promise.all([
    build({
        ...shared,
        entryPoints: ['src/renderer/index.ts'],
        outfile: 'app/dist/renderer.js',
    }),
    build({
        ...shared,
        entryPoints: ['src/hotkey/hotkey.ts'],
        outfile: 'app/dist/hotkey.js',
    }),
]);
