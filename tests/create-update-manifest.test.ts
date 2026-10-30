import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUpdateManifest } from '../scripts/create-update-manifest.mjs';

const version = '0.7.0';
const signature = 'A'.repeat(64);
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'atv-update-manifest-'));
  temporaryDirectories.push(root);
  const assetsDir = path.join(root, 'assets');
  await mkdir(assetsDir);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(path.join(root, 'tauri.conf.json'), JSON.stringify({ version }));
  await writeFile(
    path.join(root, 'Cargo.toml'),
    `[package]\nname = "test"\nversion = "${version}"\n`,
  );
  return {
    assetsDir,
    version,
    baseUrl: 'https://github.com/energee/appletv-desktop-remote/releases/download/v0.7.0',
    notes: '## Changes\n\n- Improve updating',
    pubDate: '2026-10-29T12:34:56Z',
    packageJsonPath: path.join(root, 'package.json'),
    tauriConfigPath: path.join(root, 'tauri.conf.json'),
    cargoTomlPath: path.join(root, 'Cargo.toml'),
  };
}

async function addUpdateAsset(directory: string, suffix: string, sig = signature) {
  const asset = `Apple.TV.Remote_${version}_${suffix}`;
  await writeFile(path.join(directory, asset), 'bundle');
  await writeFile(path.join(directory, `${asset}.sig`), sig);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('createUpdateManifest', () => {
  it('maps every updater platform to GitHub-safe asset names and preserves release notes', async () => {
    const options = await fixture();
    await Promise.all([
      addUpdateAsset(options.assetsDir, 'aarch64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x86_64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x64-setup.exe'),
    ]);

    await expect(createUpdateManifest(options)).resolves.toEqual({
      version,
      notes: '## Changes\n\n- Improve updating',
      pub_date: '2026-10-29T12:34:56.000Z',
      platforms: {
        'darwin-aarch64': {
          signature,
          url: `${options.baseUrl}/Apple.TV.Remote_0.7.0_aarch64.app.tar.gz`,
        },
        'darwin-x86_64': {
          signature,
          url: `${options.baseUrl}/Apple.TV.Remote_0.7.0_x86_64.app.tar.gz`,
        },
        'windows-x86_64': {
          signature,
          url: `${options.baseUrl}/Apple.TV.Remote_0.7.0_x64-setup.exe`,
        },
      },
    });
  });

  it('fails when a required signature is absent', async () => {
    const options = await fixture();
    await Promise.all([
      addUpdateAsset(options.assetsDir, 'aarch64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x86_64.app.tar.gz'),
      writeFile(path.join(options.assetsDir, `Apple.TV.Remote_${version}_x64-setup.exe`), 'bundle'),
    ]);

    await expect(createUpdateManifest(options)).rejects.toThrow(
      'Expected exactly one Apple.TV.Remote_0.7.0_x64-setup.exe.sig, found 0',
    );
  });

  it('fails when a required signature is malformed', async () => {
    const options = await fixture();
    await Promise.all([
      addUpdateAsset(options.assetsDir, 'aarch64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x86_64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x64-setup.exe', 'not a signature'),
    ]);

    await expect(createUpdateManifest(options)).rejects.toThrow('Invalid updater signature');
  });

  it('fails when the tag version disagrees with a project version', async () => {
    const options = await fixture();
    await Promise.all([
      addUpdateAsset(options.assetsDir, 'aarch64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x86_64.app.tar.gz'),
      addUpdateAsset(options.assetsDir, 'x64-setup.exe'),
    ]);
    await writeFile(options.cargoTomlPath, '[package]\nversion = "0.7.1"\n');

    await expect(createUpdateManifest(options)).rejects.toThrow(
      'Release version 0.7.0 does not match project version 0.7.1',
    );
  });
});
