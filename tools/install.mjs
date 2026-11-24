// Install (vendor) this core into an app:
//
//   npm run install-into -- ../mandalart [--force]
//
// Copies app/core, server/pwacore, test/pwacore and tools/pwacore into the app, removes
// files the core no longer has, and writes core.lock.json: the core
// version, this repo's state (commit, or null before the first commit) and a
// sha256 per file. The app's tests check the lock, so the copy is never
// edited by hand. It refuses to overwrite a copy that was edited by hand,
// or files in those folders that the lock doesn't list, unless --force.
// Nothing outside the vendored folders and the lock is touched.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_FILE, VENDORED, checkLock, hashFiles, listVendored, treeHash } from './pwacore/lock.mjs';

export { VENDORED };

/** @param {string} from */
export const coreFiles = (from) => listVendored(from);

/** @param {string} dir */
function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (name.isDirectory()) removeEmptyDirs(join(dir, name.name));
  }
  if (!readdirSync(dir).length) rmdirSync(dir);
}

/** @typedef {{ commit?: string | null, uncommitted?: boolean }} Source */

/**
 * allowUncommitted: install a core with uncommitted changes. The lock then
 * names a commit that doesn't hold the copy, so the CLI asks for --uncommitted.
 * @param {{ from: string, to: string, source?: Source, force?: boolean, allowUncommitted?: boolean }} opts
 */
export function installCore({ from, to, source = {}, force = false, allowUncommitted = true }) {
  from = resolve(from);
  to = resolve(to);
  if (from === to) throw new Error('Refusing to install the core into itself.');
  if (source.uncommitted && !allowUncommitted) {
    throw new Error('The core has uncommitted changes in its vendored folders: commit them first, or pass --uncommitted\n(the lock then says uncommitted: true, and its commit does not hold this copy).');
  }
  if (!force) {
    const problems = existsSync(join(to, LOCK_FILE)) ? checkLock(to) : listVendored(to).map((f) => `${f} is not part of the core (there is no ${LOCK_FILE} yet)`);
    if (problems.length) throw new Error(`Not installing; pass --force to overwrite:\n  ${problems.join('\n  ')}`);
  }
  const files = coreFiles(from);
  const keep = new Set(files);
  for (const f of listVendored(to)) if (!keep.has(f)) rmSync(join(to, f));
  for (const f of files) {
    mkdirSync(dirname(join(to, f)), { recursive: true });
    copyFileSync(join(from, f), join(to, f));
  }
  for (const d of VENDORED) removeEmptyDirs(join(to, d));
  const hashes = hashFiles(to, files);
  const version = /CORE_VERSION = '([^']+)'/.exec(readFileSync(join(from, 'app/core/version.js'), 'utf8'))?.[1] ?? null;
  const lock = { core_version: version, source: { repo: 'pwa-core', ...source }, tree_sha256: treeHash(hashes), files: hashes };
  writeFileSync(join(to, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

// This repo's state, for the lock. Before the first commit there is no
// commit to name, so the lock says so and the tree hash identifies the copy.
/** @param {string} from @returns {Source} */
export function gitSource(from) {
  /** @param {...string} args */
  const git = (...args) => execFileSync('git', args, { cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit = null;
  try { commit = git('rev-parse', '--verify', 'HEAD'); } catch { /* no commit yet */ }
  let uncommitted = true;
  try { uncommitted = commit === null || git('status', '--porcelain', '--', ...VENDORED).length > 0; } catch { /* not a repo */ }
  return { commit, uncommitted };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const allowUncommitted = args.includes('--uncommitted');
  const rest = args.filter((a) => a !== '--force' && a !== '--uncommitted');
  if (rest.length !== 1) {
    console.error('Usage: npm run install-into -- <app-folder> [--force] [--uncommitted]');
    process.exit(2);
  }
  const from = fileURLToPath(new URL('..', import.meta.url));
  try {
    const lock = installCore({ from, to: rest[0], source: gitSource(from), force, allowUncommitted });
    console.log(`Installed pwa-core ${lock.core_version} (${Object.keys(lock.files).length} files, commit ${lock.source.commit ?? 'none yet'}) into ${rest[0]}.`);
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}
