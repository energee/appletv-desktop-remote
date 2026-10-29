// Builds the packaged Node sidecar: the pinned, checksum-verified Node runtime (cached in
// dist/node-runtime) plus the bundled src/sidecar entrypoint, for the Tauri build target.
import console from 'node:console';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, URL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeVersion = '24.19.0';
// Official release archive hashes. Updating the runtime requires updating this pin.
const archives = {
  'darwin-arm64': '8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d',
  'darwin-x64': 'd1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316',
  'linux-arm64': 'd28c8a5bf0a808f0ed434a1dce8c54ae98f0371c0bd86ac58abc613f73e6643f',
  'linux-x64': 'f625d97cd707df4ff96254916fbc5ff014f09c09effe5a1e0ca8f6d41a8789d4',
  'win32-arm64': '8502f4a50b458d4cc38ed8f2001556c2cd239d464920f74017926ccb1e1c157f',
  'win32-x64': '57f71ab3652e797d84acddc79c81cc9ff1c6ddb2a1974cdb83f00fee9bff4c73',
};
// Tauri sets TAURI_ENV_TARGET_TRIPLE for its before*Command hooks (the host triple unless
// `tauri build --target` names another); run directly, the sidecar targets the host.
const tauriTargets = {
  'aarch64-apple-darwin': 'darwin-arm64',
  'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64',
  'x86_64-pc-windows-msvc': 'win32-x64',
};
const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
const target = triple ? tauriTargets[triple] : `${process.platform}-${process.arch}`;
const expectedHash = archives[target];
if (!expectedHash) throw new Error(`Unsupported sidecar target: ${triple ?? target}`);
const [platform, arch] = target.split('-');
const windows = platform === 'win32';
const nodeName = windows ? 'node.exe' : 'node';
const archiveRoot = `node-v${nodeVersion}-${windows ? 'win' : platform}-${arch}`;
const archiveName = `${archiveRoot}.${windows ? 'zip' : 'tar.gz'}`;
// macOS: strip local symbols (and so re-sign); elsewhere the upstream binary is used as is.
const stripLocalSymbols = platform === 'darwin';
const runtimeCache = path.join(root, 'dist', 'node-runtime', `v${nodeVersion}-${target}`);
const output = path.join(root, 'dist', 'sidecar', target);
const desktopBackend = path.join(root, 'dist', 'desktop-backend');

async function sha256(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function dependencyLicenses(inputs) {
  const packages = new Map();
  for (const input of Object.keys(inputs)) {
    if (!input.includes('node_modules/')) continue;
    let dir = path.dirname(path.resolve(root, input));
    while (dir !== path.dirname(dir)) {
      try {
        const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
        if (manifest.name && !packages.has(dir)) packages.set(dir, manifest);
        break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        dir = path.dirname(dir);
      }
    }
  }
  const sections = [];
  for (const [dir, manifest] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const files = await readdir(dir);
    let names = files.filter((name) =>
      /^(?:un)?licen[sc]e(?:\.|$)|^(?:copying|notice)(?:\.|$)/i.test(name),
    );
    // Some packages publish their license only in the README.
    if (names.length === 0) names = files.filter((name) => /^readme(\.|$)/i.test(name));
    const texts = await Promise.all(
      names.sort().map((name) => readFile(path.join(dir, name), 'utf8')),
    );
    if (
      !texts.some((text) => /copyright|redistribution|permission is hereby granted/i.test(text))
    ) {
      throw new Error(`Missing license text for ${manifest.name}`);
    }
    sections.push(
      `${manifest.name}@${manifest.version} (${manifest.license ?? 'see license'})\n\n${texts.join('\n\n')}`,
    );
  }
  return sections.join('\n\n========================================\n\n');
}

/**
 * Downloads, verifies, and prepares the pinned runtime into `runtimeCache` (node binary and
 * NODE-LICENSE). The cache directory appears only once complete, so its presence means done.
 */
async function prepareRuntime() {
  await mkdir(path.dirname(runtimeCache), { recursive: true });
  // Staged beside the cache, so the final rename stays on one filesystem.
  const temporary = await mkdtemp(`${runtimeCache}.partial-`);
  try {
    const url = `https://nodejs.org/dist/v${nodeVersion}/${archiveName}`;
    console.log(`Downloading pinned Node ${nodeVersion} for ${target}`);
    const response = await globalThis.fetch(url);
    if (!response.ok || !response.body)
      throw new Error(`Runtime download failed: HTTP ${response.status}`);
    const archive = path.join(temporary, archiveName);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
    if ((await sha256(archive)) !== expectedHash) throw new Error('Node archive SHA-256 mismatch');

    const runtimeEntry = `${archiveRoot}/${windows ? nodeName : `bin/${nodeName}`}`;
    execFileSync('tar', ['-xf', archive, '-C', temporary, runtimeEntry, `${archiveRoot}/LICENSE`]);
    const staged = path.join(temporary, 'runtime');
    await mkdir(staged);
    const node = path.join(staged, nodeName);
    await copyFile(path.join(temporary, runtimeEntry), node);
    await chmod(node, 0o755);
    if (stripLocalSymbols) {
      execFileSync('strip', ['-S', '-x', node]);
      // Stripping invalidates the upstream signature. This ad-hoc signature has no hardened
      // runtime, so V8's JIT needs no entitlements; a notarized release must re-sign node
      // with its Developer ID, the hardened runtime, and JIT entitlements.
      execFileSync('codesign', ['--force', '--sign', '-', node]);
      execFileSync('codesign', ['--verify', node]);
    }
    await copyFile(path.join(temporary, archiveRoot, 'LICENSE'), path.join(staged, 'NODE-LICENSE'));
    await rename(staged, runtimeCache);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (existsSync(runtimeCache)) {
  console.log(`Using cached Node ${nodeVersion} for ${target}`);
} else {
  await prepareRuntime();
}
await mkdir(output, { recursive: true });
await copyFile(path.join(runtimeCache, nodeName), path.join(output, nodeName));
await copyFile(path.join(runtimeCache, 'NODE-LICENSE'), path.join(output, 'NODE-LICENSE'));
await copyFile(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));

const library = JSON.parse(
  await readFile(path.join(root, 'app/node_modules/node-appletv-remote/package.json'), 'utf8'),
);
const app = JSON.parse(await readFile(path.join(root, 'app/package.json'), 'utf8'));
if (library.version !== '0.5.0')
  throw new Error('Sidecar requires node-appletv-remote 0.5.0; run pnpm --dir app install');
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/sidecar/index.ts'],
  nodePaths: [path.join(root, 'app/node_modules')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  minify: true,
  keepNames: true,
  sourcemap: false,
  legalComments: 'external',
  metafile: true,
  outfile: path.join(output, 'sidecar.mjs'),
});
await writeFile(
  path.join(output, 'THIRD-PARTY-LICENSES.txt'),
  await dependencyLicenses(result.metafile.inputs),
);
await writeFile(
  path.join(output, 'manifest.json'),
  JSON.stringify(
    {
      appVersion: app.version,
      protocolVersion: 1,
      nodeVersion,
      libraryVersion: library.version,
      target,
      nodeArchiveSha256: expectedHash,
      nodeSha256: await sha256(path.join(output, nodeName)),
      localSymbolsStripped: stripLocalSymbols,
      runtimeSigning: stripLocalSymbols ? 'adhoc' : 'upstream',
      entrypoint: 'sidecar.mjs',
    },
    null,
    2,
  ) + '\n',
);

const names = await readdir(output);
let bytes = 0;
for (const name of names) bytes += (await stat(path.join(output, name))).size;
await rm(desktopBackend, { recursive: true, force: true });
await cp(output, desktopBackend, { recursive: true });
console.log(JSON.stringify({ output, bytes }, null, 2));
