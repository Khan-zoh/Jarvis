import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * electron-builder rebuilds better-sqlite3 for Electron, then stages the unpacked native binary
 * using a hard link to the workspace copy. A plain `npm rebuild better-sqlite3` afterward mutates
 * both names through that shared inode, silently leaving win-unpacked with the Node ABI.
 *
 * Preserve the Electron bytes, unlink the packaged name to break the hard link, restore the
 * workspace to the Node ABI, then write the Electron bytes back as an independent packaged file.
 * This leaves both `npm test` and the packaged second brain runnable after package/dist.
 */
const packagedBinary = resolve(
  'dist-package',
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);
const workspaceBinary = resolve(
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node'
);

if (!existsSync(packagedBinary)) {
  throw new Error(`packaged better-sqlite3 binary not found: ${packagedBinary}`);
}

// Fail the build if the staged binary cannot actually load under the target Electron ABI. Merely
// importing `better-sqlite3` is insufficient because it lazily dlopens this file on first DB open;
// requiring the .node file directly forces the ABI check.
const electronExe = resolve(
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);
const abiCheck = spawnSync(electronExe, ['-e', `require(${JSON.stringify(packagedBinary)})`], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8'
});
if (abiCheck.error) throw abiCheck.error;
if (abiCheck.status !== 0) {
  process.stderr.write(abiCheck.stderr ?? '');
  throw new Error('packaged better-sqlite3 failed the Electron ABI load check');
}

const electronAbiBinary = readFileSync(packagedBinary);
unlinkSync(packagedBinary);

const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
const args =
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm rebuild better-sqlite3']
    : ['rebuild', 'better-sqlite3'];
const rebuilt = spawnSync(command, args, {
  cwd: process.cwd(),
  stdio: 'inherit'
});

// Always restore the packaged binary, even when the workspace rebuild fails, so the release
// artifact is never left missing. The non-zero exit still fails the caller.
writeFileSync(packagedBinary, electronAbiBinary);

if (rebuilt.error) throw rebuilt.error;
if (rebuilt.status !== 0) process.exit(rebuilt.status ?? 1);

const nodeAbiCheck = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(workspaceBinary)})`], {
  cwd: process.cwd(),
  encoding: 'utf8'
});
if (nodeAbiCheck.error) throw nodeAbiCheck.error;
if (nodeAbiCheck.status !== 0) {
  process.stderr.write(nodeAbiCheck.stderr ?? '');
  throw new Error('workspace better-sqlite3 failed the Node ABI load check');
}

console.log('[native-abi] workspace=Node, packaged=Electron (hard link separated)');
