// The renderer's modules must not import each other in a cycle (#14). esbuild bundles the entry
// point the way esbuild.renderer.mjs does, and its metafile lists each module's imports.
import { build } from 'esbuild';
import { expect, it } from 'vitest';

it('has no import cycles among the renderer modules', async () => {
  const { metafile } = await build({
    entryPoints: ['src/renderer/index.ts'],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const imports = new Map(
    Object.entries(metafile.inputs)
      .filter(([file]) => file.startsWith('src/'))
      .map(([file, input]) => [file, input.imports.map((i) => i.path)]),
  );
  const cycles: string[] = [];
  const path: string[] = [];
  const done = new Set<string>();
  // Depth-first: reaching a module that is still on the path closes a cycle.
  function visit(file: string): void {
    if (path.includes(file)) {
      cycles.push([...path.slice(path.indexOf(file)), file].join(' -> '));
      return;
    }
    if (done.has(file) || !imports.has(file)) return;
    path.push(file);
    for (const next of imports.get(file)!) visit(next);
    path.pop();
    done.add(file);
  }
  for (const file of imports.keys()) visit(file);
  expect(cycles).toEqual([]);
});
