// Start a new app from this core:
//
//   npm run new-app -- ../trips --id trips --name "Trips" [--port N] [--git]
//
// Copies the core (only the files git has: not its history, data, local
// notes, caches or anything untracked) into a new
// folder and sets the app's name and storage id in every file that holds
// them. --git also runs git init with the repo hygiene: TASK.md,
// CLAUDE.local.md and .local/ excluded, this repo's commit email (a
// GitHub noreply address) copied over, and the git hooks in .githooks/ on
// (npm run hooks does the same later, for an app made without --git).
// Nothing is committed.
//
// Ports: each app gets its own, and its tailnet HTTPS port uses the same
// number, so each app is its own origin with its own browser storage.
// --port N picks one; without it the app gets the lowest port from 8765 up
// that nothing claims. Claims are each sibling app's PORT line (an app is a
// folder with core.lock.json; one without a PORT line runs on 8765) and every
// port `tailscale serve status` uses. Never what is listening now: apps are
// not always running.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCK_FILE, hashFiles, listVendored, treeHash } from './pwacore/lock.mjs';
import { gitSource } from './install.mjs';

const SKIP_TOP = new Set(['.git', 'node_modules', 'data', 'dist', '.local', 'TASK.md', 'CLAUDE.local.md', '.runner-done']);
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/;
const EXCLUDE = ['TASK.md', 'CLAUDE.local.md', '.local/'];
// Only pwa-core starts apps and installs the core into them. A copy of these
// in an app would install the app's copy into other apps as if it were the core.
const CORE_ONLY = ['tools/new-app.mjs', 'tools/install.mjs', 'test/new-app.test.js', 'test/install.test.js'];
const CORE_ONLY_SCRIPTS = ['new-app', 'install-into'];
const FIRST_PORT = 8765; // also the core server's default, for an app with no PORT line
const PORT_RE = /^PORT = (\d+)\b/m;

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
 * The ports in `tailscale serve status --json` output: each served HTTPS or
 * TCP port and each local port it forwards to.
 * @param {string | null} text the output, or null when tailscale can't say
 * @returns {Set<number>}
 */
export function parseServeStatus(text) {
  /** @type {Set<number>} */
  const ports = new Set();
  if (!text?.trim()) return ports;
  let status;
  try {
    status = JSON.parse(text);
  } catch {
    throw new Error("new-app: couldn't read `tailscale serve status --json`; pass --port N");
  }
  /** @param {unknown} v */
  const add = (v) => {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
  };
  /** @param {unknown} s */
  const portOf = (s) => {
    if (typeof s !== 'string') return;
    const m = /:(\d+)(?:[/?#]|$)/.exec(s) ?? /^(\d+)$/.exec(s);
    if (m) add(m[1]);
    else if (/^https:/.test(s)) add(443);
    else if (/^http:/.test(s)) add(80);
  };
  /** @param {unknown} node */
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'TCP' && v && typeof v === 'object') Object.keys(v).forEach(add);
      else if (k === 'Web' && v && typeof v === 'object') Object.keys(v).forEach(portOf);
      else if (k === 'Proxy' || k === 'TCPForward') portOf(v);
      walk(v);
    }
  };
  walk(status);
  return ports;
}

/** @returns {string | null} `tailscale serve status --json` (read only), or null when tailscale can't say */
function tailscaleServeStatus() {
  try {
    return execFileSync('tailscale', ['serve', 'status', '--json'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Every port another app or `tailscale serve` claims.
 * @param {{ parent: string, self?: string, serveStatus?: () => string | null }} opts
 * @returns {Set<number>}
 */
export function claimedPorts({ parent, self, serveStatus = tailscaleServeStatus }) {
  const claims = parseServeStatus(serveStatus());
  const skip = self ? resolve(self) : null;
  /** @type {string[]} */
  let names = [];
  try {
    names = readdirSync(parent);
  } catch {
    // no parent folder yet: no sibling apps
  }
  for (const n of names) {
    const dir = resolve(parent, n);
    if (dir === skip || !existsSync(join(dir, LOCK_FILE))) continue;
    const launcher = join(dir, 'server/server.py');
    const m = existsSync(launcher) ? PORT_RE.exec(readFileSync(launcher, 'utf8')) : null;
    claims.add(m ? Number(m[1]) : FIRST_PORT);
  }
  return claims;
}

/** @param {Set<number>} claims @returns {number} the lowest port from 8765 up that nothing claims */
export function pickPort(claims) {
  let p = FIRST_PORT;
  while (claims.has(p)) p++;
  if (p > 65535) throw new Error('new-app: no free port; pass --port N');
  return p;
}

/**
 * @param {{ from: string, to: string, id?: string, name?: string, git?: boolean, email?: string | null, port?: number, serveStatus?: () => string | null }} opts
 * @returns {string} the new app's folder
 */
export function newApp({ from, to, id, name, git = false, email = null, port, serveStatus }) {
  if (!ID_RE.test(id ?? '')) throw new Error('The app id must be 2-40 lowercase letters, digits or dashes, starting with a letter.');
  name = String(name ?? '').trim();
  if (!name) throw new Error('The app name is required.');
  if (port !== undefined && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    throw new Error('The port must be a whole number from 1024 to 65535.');
  }
  from = resolve(from);
  to = resolve(to);
  if (existsSync(to) && readdirSync(to).length) throw new Error(`${to} is not empty.`);
  if (to === from || to.startsWith(from + sep)) throw new Error('The new app must live outside the core folder.');
  /** @type {Set<number>} */
  let claims;
  try {
    claims = claimedPorts({ parent: dirname(to), self: to, serveStatus });
  } catch (err) {
    if (port === undefined) throw err;
    // A given port is still checked against the other apps' PORT lines.
    console.warn(`${/** @type {Error} */ (err).message}: checking ${port} against the other apps only.`);
    claims = claimedPorts({ parent: dirname(to), self: to, serveStatus: () => null });
  }
  if (port !== undefined && claims.has(port)) throw new Error(`Port ${port} is taken (another app's PORT line or tailscale serve). Pick another, or leave out --port.`);
  port ??= pickPort(claims);

  mkdirSync(to, { recursive: true });
  /** @param {string} rel */
  const keep = (rel) => {
    const parts = rel.split(sep);
    return !SKIP_TOP.has(parts[0]) && !parts.some((p) => p === '__pycache__' || p === '.DS_Store');
  };
  // From a git repo, only what git has (committed or staged): never an
  // untracked or ignored file such as .env, a cache or a stray database.
  const tracked = gitFiles(from);
  if (tracked) {
    for (const rel of tracked.filter((p) => keep(p) && existsSync(join(from, p)))) {
      mkdirSync(dirname(join(to, rel)), { recursive: true });
      copyFileSync(join(from, rel), join(to, rel)); // keeps the mode (hooks stay executable)
    }
  } else {
    cpSync(from, to, { recursive: true, filter: (src) => !relative(from, src) || keep(relative(from, src)) });
  }

  /** @param {string} p */
  const f = (p) => join(to, p);
  for (const p of CORE_ONLY) rmSync(f(p), { force: true });
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
    s = replaceOnce(s, /^APP_ID = "[^"]*"/m, `APP_ID = "${id}"`, 'server.py');
    s = replaceOnce(s, PORT_RE, `PORT = ${port}`, 'server.py');
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
    for (const script of CORE_ONLY_SCRIPTS) delete p.scripts?.[script];
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

// The files git has in from (committed or staged), or null if from is not
// the top of a git repo.
/** @param {string} from @returns {string[] | null} */
function gitFiles(from) {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: from, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(top) !== realpathSync(from)) return null;
    return execFileSync('git', ['ls-files', '-z'], { cwd: from, encoding: 'utf8' }).split('\0').filter(Boolean).map((p) => p.split('/').join(sep));
  } catch {
    return null;
  }
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
  /** @type {{ git: boolean, id?: string, name?: string, port?: number }} */
  const args = { git: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id') args.id = argv[++i];
    else if (argv[i] === '--name') args.name = argv[++i];
    else if (argv[i] === '--port') {
      const v = argv[++i] ?? '';
      if (!/^\d+$/.test(v)) throw new Error(`--port needs a number, not "${v}".`);
      args.port = Number(v);
    } else if (argv[i] === '--git') args.git = true;
    else rest.push(argv[i]);
  }
  if (rest.length !== 1) {
    console.error('Usage: npm run new-app -- <folder> --id <storage-id> --name "<Display Name>" [--port N] [--git]');
    process.exit(2);
  }
  const from = fileURLToPath(new URL('..', import.meta.url));
  const to = newApp({ from, to: rest[0], id: args.id, name: args.name ?? basename(rest[0]), git: args.git, email: args.git ? coreEmail(from) : null, port: args.port });
  const port = Number(PORT_RE.exec(readFileSync(join(to, 'server/server.py'), 'utf8'))?.[1]);
  console.log(`Made ${to} on port ${port}. Next:\n  cd ${rest[0]}\n  npm install && npm test\nThen replace the example (app/js/notes.js, test/notes.test.js) with your app.\nOn the tailnet, the same number: tailscale serve --bg --https=${port} ${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (err) {
    console.error(/** @type {Error} */ (err).message);
    process.exit(1);
  }
}
