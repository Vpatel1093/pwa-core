// The vendored core and its lock. An app holds a copy of the core in the
// VENDORED folders and a core.lock.json that lists a sha256 per file. The
// app's tests run checkLock, so a hand edit to the copy fails the suite:
// a fix the core needs is made in pwa-core and installed again
// (pwa-core's tools/install.mjs).
//
//   node tools/pwacore/lock.mjs     # exit 1 and a list if the copy drifted

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCK_FILE = 'core.lock.json';
export const VENDORED = ['app/core', 'server/pwacore', 'tools/pwacore'];

/** @typedef {Record<string, string>} FileHashes path -> sha256 hex */

/** @param {string} name */
const skip = (name) => name.startsWith('.') || name === '__pycache__' || name.endsWith('.pyc');

/** @param {import('node:crypto').BinaryLike} buf */
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** @param {string} dir @param {string} base @returns {string[]} */
function walk(dir, base) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    if (skip(name)) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, base) : [relative(base, p).split(sep).join('/')];
  });
}

// Every file in the vendored folders under root, sorted, as '/' paths.
/** @param {string} root */
export function listVendored(root) {
  root = resolve(root);
  return VENDORED.flatMap((d) => walk(join(root, d), root)).sort();
}

/** @param {string} root @param {string[]} files @returns {FileHashes} */
export function hashFiles(root, files) {
  return Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(root, f)))]));
}

/** @param {FileHashes} files */
export function treeHash(files) {
  return sha256(Object.entries(files).map(([f, h]) => `${h}  ${f}\n`).join(''));
}

// Returns a list of problems; empty means the copy matches its lock.
/** @param {string} root */
export function checkLock(root) {
  root = resolve(root);
  const lockPath = join(root, LOCK_FILE);
  if (!existsSync(lockPath)) return [`${LOCK_FILE} is missing: install the core with pwa-core's tools/install.mjs`];
  /** @type {{ files?: FileHashes, tree_sha256?: string }} */
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const problems = [];
  // A hand edit to the lock's file list shows as a tree hash that no longer matches it.
  if (lock.tree_sha256 !== treeHash(lock.files ?? {})) return [`${LOCK_FILE} was edited by hand: its tree_sha256 doesn't match its files`];
  for (const [f, hash] of Object.entries(lock.files ?? {})) {
    if (!existsSync(join(root, f))) problems.push(`${f} is missing`);
    else if (sha256(readFileSync(join(root, f))) !== hash) problems.push(`${f} was edited by hand: change it in pwa-core and install again`);
  }
  for (const f of listVendored(root)) {
    if (!Object.hasOwn(lock.files ?? {}, f)) {
      problems.push(`${f} is not part of the core: app code goes outside ${VENDORED.join(', ').replace(/, ([^,]*)$/, ' and $1')}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const problems = checkLock(root);
  if (problems.length) {
    console.error(`The vendored core drifted from ${LOCK_FILE}:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Vendored core matches ${LOCK_FILE}.`);
}
