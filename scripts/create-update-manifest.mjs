#!/usr/bin/env node
import console from 'node:console';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const platforms = [
  ['darwin-aarch64', 'aarch64.app.tar.gz'],
  ['darwin-x86_64', 'x86_64.app.tar.gz'],
  ['windows-x86_64', 'x64-setup.exe'],
];

async function filesNamed(directory, name) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...(await filesNamed(entryPath, name)));
    else if (entry.isFile() && entry.name === name) matches.push(entryPath);
  }
  return matches;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid release version: ${version}`);
  }
}

function assertSignature(signature, file) {
  const value = signature.trim();
  const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
  const isRawSignature = base64.test(value) && value.length >= 44 && value.length % 4 === 0;
  const lines = value.split(/\r?\n/);
  const isMinisignSignature =
    lines.length >= 2 &&
    lines[0].startsWith('untrusted comment:') &&
    base64.test(lines[1]) &&
    lines[1].length >= 44;
  if (!isRawSignature && !isMinisignSignature) {
    throw new Error(`Invalid updater signature in ${file}`);
  }
  return value;
}

async function readProjectVersion(file, selector) {
  const value = selector(JSON.parse(await readFile(file, 'utf8')));
  if (typeof value !== 'string') throw new Error(`No version found in ${file}`);
  return value;
}

async function readCargoVersion(file) {
  const cargo = await readFile(file, 'utf8');
  const packageSection = cargo.match(
    /^\[package\]\s*\r?\n([\s\S]*?)(?=^\[[^\]]+\]\s*$|(?![\s\S]))/m,
  )?.[1];
  const version = packageSection?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`No package version found in ${file}`);
  return version;
}

export async function createUpdateManifest({
  assetsDir,
  version,
  baseUrl,
  notes,
  pubDate,
  packageJsonPath,
  tauriConfigPath,
  cargoTomlPath,
}) {
  assertVersion(version);
  if (typeof notes !== 'string') throw new Error('Release notes must be text');
  if (Number.isNaN(Date.parse(pubDate)))
    throw new Error(`Invalid release publication date: ${pubDate}`);
  if (!baseUrl || !/^https:\/\//.test(baseUrl))
    throw new Error('The asset URL base must be an HTTPS URL');

  const versions = await Promise.all([
    readProjectVersion(packageJsonPath, (json) => json.version),
    readProjectVersion(tauriConfigPath, (json) => json.version),
    readCargoVersion(cargoTomlPath),
  ]);
  for (const projectVersion of versions) {
    if (projectVersion !== version) {
      throw new Error(
        `Release version ${version} does not match project version ${projectVersion}`,
      );
    }
  }

  const platformsManifest = {};
  for (const [platform, suffix] of platforms) {
    const asset = `Apple.TV.Remote_${version}_${suffix}`;
    const assetMatches = await filesNamed(assetsDir, asset);
    const signatureMatches = await filesNamed(assetsDir, `${asset}.sig`);
    if (assetMatches.length !== 1) {
      throw new Error(`Expected exactly one ${asset}, found ${assetMatches.length}`);
    }
    if (signatureMatches.length !== 1) {
      throw new Error(`Expected exactly one ${asset}.sig, found ${signatureMatches.length}`);
    }
    const signature = assertSignature(
      await readFile(signatureMatches[0], 'utf8'),
      signatureMatches[0],
    );
    platformsManifest[platform] = {
      signature,
      url: `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(asset)}`,
    };
  }

  return {
    version,
    notes,
    pub_date: new Date(pubDate).toISOString(),
    platforms: platformsManifest,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`Missing required option ${name}`);
  return args[index + 1];
}

async function main() {
  const args = process.argv.slice(2);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = await createUpdateManifest({
    assetsDir: path.resolve(option(args, '--assets-dir')),
    version: option(args, '--version'),
    baseUrl: option(args, '--base-url'),
    notes: await readFile(option(args, '--notes-file'), 'utf8'),
    pubDate: option(args, '--pub-date'),
    packageJsonPath: path.resolve(
      args.includes('--package-json')
        ? option(args, '--package-json')
        : path.join(root, 'package.json'),
    ),
    tauriConfigPath: path.resolve(
      args.includes('--tauri-config')
        ? option(args, '--tauri-config')
        : path.join(root, 'src-tauri/tauri.conf.json'),
    ),
    cargoTomlPath: path.resolve(
      args.includes('--cargo-toml')
        ? option(args, '--cargo-toml')
        : path.join(root, 'src-tauri/Cargo.toml'),
    ),
  });
  await writeFile(
    path.join(path.resolve(option(args, '--assets-dir')), 'latest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
