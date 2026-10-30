import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const output = 'dist/frontend';
const shared = {
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'iife',
  sourcemap: false,
  loader: { '.md': 'text' },
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await Promise.all([
  cp('app/css', `${output}/css`, { recursive: true }),
  cp('app/images', `${output}/images`, { recursive: true }),
  cp('app/index.html', `${output}/index.html`),
  cp('app/hotkey.html', `${output}/hotkey.html`),
  build({
    ...shared,
    entryPoints: ['src/renderer/index.ts'],
    outfile: `${output}/renderer.js`,
  }),
  build({
    ...shared,
    entryPoints: ['src/hotkey/hotkey.ts'],
    outfile: `${output}/hotkey.js`,
  }),
]);
