// Start a new app from this core:
//
//   npm run new-app -- ../trips --id trips --name "Trips" [--git]
//
// Copies the core (not its git history, data, or local notes) into a new
// folder and sets the app's name and storage id in every file that holds
// them. --git also runs git init with the repo hygiene: TASK.md,
// CLAUDE.local.md and .local/ excluded, this repo's commit email (a
// GitHub noreply address) copied over, and the git hooks in .githooks/ on
// (npm run hooks does the same later, for an app made without --git).
// Nothing is committed.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_FILE, hashFiles, listVendored, treeHash } from './pwacore/lock.mjs';
import { gitSource } from './install.mjs';

const SKIP_TOP = new Set(['.git', 'node_modules', 'data', 'dist', '.local', 'TASK.md', 'CLAUDE.local.md', '.runner-done']);
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const EXCLUDE = ['TASK.md', 'CLAUDE.local.md', '.local/'];

/** @param {string} s */
const html = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** @param {string} file @param {(text: string) => string} fn */
function edit(file, fn) {
  writeFileSync(file, fn(readFileSync(file, 'utf8')));
}

/** @param {string} text @param {RegExp} re @param {string} value @param {string} file */
function replaceOnce(text, re, value, file) {
  if (!re.test(text)) throw new Error(`new-app: couldn't find ${re} in ${file}`);
  return text.replace(re, () => value);
}

/**
 * @param {{ from: string, to: string, id?: string, name?: string, git?: boolean, email?: string | null }} opts
 * @returns {string} the new app's folder
 */
export function newApp({ from, to, id, name, git = false, email = null }) {
  if (!ID_RE.test(id ?? '')) throw new Error('The app id must be 2-40 lowercase letters, digits or dashes, starting with a letter.');
  name = String(name ?? '').trim();
  if (!name) throw new Error('The app name is required.');
  from = resolve(from);
  to = resolve(to);
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty.`);
  if (to === from || to.startsWith(from + sep)) throw new Error('The new app must live outside the core folder.');

  mkdirSync(to, { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      if (!rel) return true;
      const parts = rel.split(sep);
      if (SKIP_TOP.has(parts[0])) return false;
      return !parts.some((p) => p === '__pycache__' || p === '.DS_Store');
    },
  });

  /** @param {string} p */
  const f = (p) => join(to, p);
  edit(f('app/js/config.js'), (s) => {
    s = replaceOnce(s, /export const APP_NAME = .*;/, `export const APP_NAME = ${JSON.stringify(name)};`, 'config.js');
    s = replaceOnce(s, /export const APP_ID = .*;/, `export const APP_ID = '${id}';`, 'config.js');
    return replaceOnce(s, /export const APP_VERSION = .*;/, "export const APP_VERSION = '0.1.0';", 'config.js');
  });
  edit(f('app/sw.js'), (s) => {
    s = replaceOnce(s, /const APP_ID = '[^']*';/, `const APP_ID = '${id}';`, 'sw.js');
    return replaceOnce(s, /const VERSION = '[^']*';/, "const VERSION = '0.1.0';", 'sw.js');
  });
  edit(f('server/server.py'), (s) => {
    s = replaceOnce(s, /^APP_VERSION = "[^"]*"/m, 'APP_VERSION = "0.1.0"', 'server.py');
    s = replaceOnce(s, /^DB_NAME = "[^"]*"/m, `DB_NAME = "${id}.db"`, 'server.py');
    return replaceOnce(s, /description="(?:[^"\\]|\\.)*"/, `description=${JSON.stringify(`${name} sync server`)}`, 'server.py');
  });
  edit(f('app/manifest.webmanifest'), (s) => {
    const m = JSON.parse(s);
    Object.assign(m, { id, name, short_name: name });
    return `${JSON.stringify(m, null, 2)}\n`;
  });
  edit(f('app/index.html'), (s) => {
    s = replaceOnce(s, /<title>[^<]*<\/title>/, `<title>${html(name)}</title>`, 'index.html');
    return replaceOnce(s, /name="apple-mobile-web-app-title" content="[^"]*"/, `name="apple-mobile-web-app-title" content="${html(name)}"`, 'index.html');
  });
  edit(f('package.json'), (s) => {
    const p = JSON.parse(s);
    Object.assign(p, { name: id, version: '0.1.0', description: name });
    delete p.scripts?.['new-app'];
    return `${JSON.stringify(p, null, 2)}\n`;
  });
  // The core README describes the core; the new app gets its own.
  const versionFile = f('app/core/version.js');
  const coreVersion = existsSync(versionFile) ? /CORE_VERSION = '([^']+)'/.exec(readFileSync(versionFile, 'utf8'))?.[1] : null;
  mkdirSync(f('docs'), { recursive: true });
  renameSync(f('README.md'), f('docs/core.md'));
  writeFileSync(f('README.md'), `# ${name}\n\nBuilt on pwa-core ${coreVersion ?? '(unknown version)'}. How the core works, and how to update it: [docs/core.md](docs/core.md).\n`);
  if (existsSync(f('package-lock.json'))) {
    edit(f('package-lock.json'), (s) => {
      const lock = JSON.parse(s);
      lock.name = id;
      lock.version = '0.1.0';
      if (lock.packages?.['']) Object.assign(lock.packages[''], { name: id, version: '0.1.0' });
      return `${JSON.stringify(lock, null, 2)}\n`;
    });
  }

  // The new app's copy of the core is vendored like any other app's.
  const hashes = hashFiles(to, listVendored(to));
  const lock = { core_version: coreVersion, source: { repo: 'pwa-core', ...gitSource(from) }, tree_sha256: treeHash(hashes), files: hashes };
  writeFileSync(f(LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);

  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: to });
    appendFileSync(f('.git/info/exclude'), `${EXCLUDE.join('\n')}\n`);
    if (email) execFileSync('git', ['config', '--local', 'user.email', email], { cwd: to });
    execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: to });
  }
  return to;
}

/** @param {string} from */
function coreEmail(from) {
  try {
    return execFileSync('git', ['config', '--local', 'user.email'], { cwd: from, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

/** @param {string[]} argv */
function cli(argv) {
  /** @type {{ git: boolean, id?: string, name?: string }} */
  const args = { git: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') args.id = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--git') args.git = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) {
    console.error('Usage: npm run new-app -- <folder> --id <storage-id> --name "<Display Name>" [--git]');
    process.exit(2);
  }
  const from = fileURLToPath(new URL('..', import.meta.url));
  const to = newApp({ from, to: rest[0], id: args.id, name: args.name ?? basename(rest[0]), git: args.git, email: args.git ? coreEmail(from) : null });
  console.log(`Made ${to}. Next:\n  cd ${rest[0]}\n  npm install && npm test\nThen replace the example (app/js/notes.js, test/notes.test.js) with your app.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}
