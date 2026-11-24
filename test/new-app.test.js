import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLock } from '../tools/pwacore/lock.mjs';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync, statSync, cpSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newApp, claimedPorts, pickPort, parseServeStatus } from '../tools/new-app.mjs';
import { RUFF_VERSION } from '../tools/pwacore/lint.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

/** @param {import('node:test').TestContext} t */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'pwacore-new-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('newApp copies the core and sets the name and storage id everywhere', (t) => {
  const to = join(scratch(t), 'trips');
  newApp({ from: CORE, to, id: 'trips', name: 'Trips "beta" & co' });
  /** @param {string} f */
  const read = (f) => readFileSync(join(to, f), 'utf8');
  assert.match(read('app/js/config.js'), /APP_ID = 'trips';/);
  assert.match(read('app/js/config.js'), /APP_NAME = "Trips \\"beta\\" & co";/);
  assert.match(read('app/sw.js'), /const APP_ID = 'trips';/);
  const manifest = JSON.parse(read('app/manifest.webmanifest'));
  assert.equal(manifest.id, 'trips');
  assert.equal(manifest.name, 'Trips "beta" & co');
  assert.match(read('app/index.html'), /<title>Trips &quot;beta&quot; &amp; co<\/title>/);
  assert.equal(JSON.parse(read('package.json')).name, 'trips');
  assert.match(read('server/server.py'), /^DB_NAME = "trips\.db"/m);
  assert.match(read('server/server.py'), /^APP_ID = "trips"/m);
  assert.match(read('server/server.py'), /description="Trips \\"beta\\" & co sync server"/);
  assert.match(read('README.md'), /^# Trips "beta" & co/);
  assert.ok(existsSync(join(to, 'docs/core.md')), 'the core README comes along as docs/core.md');
  assert.deepEqual(checkLock(to), [], 'a new app starts with a lock for its core copy');
  assert.equal(JSON.parse(read('core.lock.json')).source.repo, 'pwa-core');
  // The new app's own consistency checks pass (HTML entities decode to the name).
  // NODE_TEST_CONTEXT would make the child report to this runner instead of stdout.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/shell.test.js'], { cwd: to, encoding: 'utf8', env });
  assert.match(out, /# fail 0/);
});

test('a new app starts with the type check: its configs, the script and pinned TypeScript', (t) => {
  const to = join(scratch(t), 'typed');
  newApp({ from: CORE, to, id: 'typed', name: 'Typed' });
  /** @param {string} root */
  const pkgOf = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const core = pkgOf(CORE);
  const pkg = pkgOf(to);
  assert.equal(pkg.scripts.typecheck, core.scripts.typecheck);
  assert.match(pkg.scripts.check, /npm run typecheck/, 'npm run check runs the type check');
  for (const dep of ['typescript', '@types/node']) {
    assert.match(core.devDependencies[dep] ?? '', /^\d+\.\d+\.\d+$/, `${dep} is pinned to an exact version`);
    assert.equal(pkg.devDependencies[dep], core.devDependencies[dep]);
  }
  for (const f of ['tsconfig.json', 'tsconfig.sw.json']) assert.ok(existsSync(join(to, f)), `${f} comes along`);
  // The renamed copy type-checks. It borrows the core's node_modules; the
  // app gets its own with npm install.
  symlinkSync(join(CORE, 'node_modules'), join(to, 'node_modules'), 'dir');
  const tsc = join(CORE, 'node_modules/typescript/bin/tsc');
  for (const config of ['tsconfig.json', 'tsconfig.sw.json']) {
    execFileSync(process.execPath, [tsc, '-p', join(to, config)], { cwd: to, encoding: 'utf8' });
  }
});

test('a new app starts with lint and the git hooks: configs, scripts, pinned ESLint', (t) => {
  const to = join(scratch(t), 'linted');
  newApp({ from: CORE, to, id: 'linted', name: 'Linted App' });
  /** @param {string} root */
  const pkgOf = (root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const core = pkgOf(CORE);
  const pkg = pkgOf(to);
  for (const s of ['lint', 'hooks']) assert.equal(pkg.scripts[s], core.scripts[s], `the ${s} script comes along`);
  assert.match(pkg.scripts.check, /npm run lint/, 'npm run check runs lint');
  for (const dep of ['eslint', '@eslint/js', 'globals']) {
    assert.match(core.devDependencies[dep] ?? '', /^\d+\.\d+\.\d+$/, `${dep} is pinned to an exact version`);
    assert.equal(pkg.devDependencies[dep], core.devDependencies[dep]);
  }
  for (const f of ['eslint.config.js', 'ruff.toml']) assert.ok(existsSync(join(to, f)), `${f} comes along`);
  for (const hook of ['pre-commit', 'pre-merge-commit', 'pre-push']) {
    assert.ok(statSync(join(to, '.githooks', hook)).mode & 0o100, `${hook} comes along, executable`);
  }
  // The renamed copy lints clean. It borrows the core's node_modules.
  symlinkSync(join(CORE, 'node_modules'), join(to, 'node_modules'), 'dir');
  execFileSync(process.execPath, [join(CORE, 'node_modules/eslint/bin/eslint.js'), '.'], { cwd: to, encoding: 'utf8' });
  if (spawnSync('uvx', ['--version']).error) return t.diagnostic('uvx not found: ruff not run on the copy');
  for (const args of [['check'], ['format', '--check']]) {
    execFileSync('uvx', [`ruff@${RUFF_VERSION}`, ...args], { cwd: to, encoding: 'utf8', stdio: 'pipe' });
  }
});

test('a new app leaves out the core-only tools and gets the lock test, which catches a hand edit', (t) => {
  const to = join(scratch(t), 'locked');
  newApp({ from: CORE, to, id: 'locked', name: 'Locked' });
  for (const f of ['tools/new-app.mjs', 'tools/install.mjs', 'test/new-app.test.js', 'test/install.test.js']) {
    assert.ok(!existsSync(join(to, f)), `${f} is core-only`);
  }
  const pkg = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['install-into'], undefined, 'install-into is core-only');
  assert.equal(pkg.scripts['new-app'], undefined, 'new-app is core-only');
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = () => spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/pwacore/core-lock.test.js'], { cwd: to, encoding: 'utf8', env });
  const ok = run();
  assert.match(ok.stdout, /# pass 1/, 'the lock test runs and passes in the app');
  writeFileSync(join(to, 'app/core/uuid.js'), `${readFileSync(join(to, 'app/core/uuid.js'), 'utf8')}// hand edit\n`);
  const bad = run();
  assert.notEqual(bad.status, 0, 'a hand edit to the vendored core fails the app\'s tests');
  assert.match(bad.stdout, /app\/core\/uuid\.js/);
});

test("a new app gets the core's own tests, covered by the lock, and they pass there", (t) => {
  const to = join(scratch(t), 'tested');
  newApp({ from: CORE, to, id: 'tested', name: 'Tested' });
  const lock = JSON.parse(readFileSync(join(to, 'core.lock.json'), 'utf8'));
  for (const f of ['test/pwacore/events.test.js', 'test/pwacore/sync.test.js', 'test/pwacore/helpers/fake-server.js', 'server/pwacore/test_server.py']) {
    assert.ok(Object.hasOwn(lock.files, f), `${f} travels with the core`);
  }
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const js = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/pwacore/events.test.js', 'test/pwacore/agree.test.js'], { cwd: to, encoding: 'utf8', env });
  assert.equal(js.status, 0, js.stdout);
  assert.match(js.stdout, /# fail 0/);
  const pkg = JSON.parse(readFileSync(join(to, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['test:js'], /test\/pwacore\/\*\.test\.js/, 'npm test runs them');
  writeFileSync(join(to, 'test/pwacore/uuid.test.js'), `${readFileSync(join(to, 'test/pwacore/uuid.test.js'), 'utf8')}// hand edit\n`);
  const bad = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/pwacore/core-lock.test.js'], { cwd: to, encoding: 'utf8', env });
  assert.notEqual(bad.status, 0, "a hand edit to the core's tests fails the lock too");
  assert.match(bad.stdout, /test\/pwacore\/uuid\.test\.js/);
});

test('newApp leaves out local, generated and private files', (t) => {
  const from = scratch(t);
  for (const f of ['app/js/config.js', 'app/sw.js', 'app/manifest.webmanifest', 'app/index.html', 'server/server.py', 'package.json', 'README.md']) {
    mkdirSync(join(from, f, '..'), { recursive: true });
    writeFileSync(join(from, f), readFileSync(join(CORE, f)));
  }
  for (const f of ['TASK.md', 'CLAUDE.local.md', '.local/x', 'data/events.db', 'dist/index.html', 'node_modules/p/i.js', 'server/__pycache__/s.pyc', '.git/HEAD', 'app/.DS_Store']) {
    mkdirSync(join(from, f, '..'), { recursive: true });
    writeFileSync(join(from, f), 'x');
  }
  const to = join(scratch(t), 'app2');
  newApp({ from, to, id: 'app-two', name: 'App Two' });
  for (const f of ['TASK.md', 'CLAUDE.local.md', '.local', 'data', 'dist', 'node_modules', 'server/__pycache__', '.git', 'app/.DS_Store']) {
    assert.ok(!existsSync(join(to, f)), `${f} should not be copied`);
  }
});

test('from a git repo, newApp copies only the files git has, never untracked or ignored ones', (t) => {
  // A small git copy of the core, so the test can leave files lying around in it.
  const core = join(scratch(t), 'core');
  // (CORE may itself be a plain copy, as in the pre-push hook, so no git here.)
  const skip = new Set(['node_modules', '.git', 'dist', 'data', '.local', '.ruff_cache', '__pycache__']);
  cpSync(CORE, core, { recursive: true, filter: (src) => !skip.has(basename(src)) });
  /** @param {...string} args */
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], { cwd: core, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'core');
  writeFileSync(join(core, '.env'), 'SECRET=1\n');
  mkdirSync(join(core, '.ruff_cache'));
  writeFileSync(join(core, '.ruff_cache/x'), 'cache');
  writeFileSync(join(core, 'scratch.db'), 'not for the new app');
  writeFileSync(join(core, 'app/js/staged.js'), 'export const s = 1;\n');
  git('add', 'app/js/staged.js');
  const to = join(scratch(t), 'clean');
  newApp({ from: core, to, id: 'clean', name: 'Clean' });
  for (const f of ['.env', '.ruff_cache', 'scratch.db']) assert.ok(!existsSync(join(to, f)), `${f} stays behind`);
  assert.ok(existsSync(join(to, 'app/js/staged.js')), 'a staged file comes along');
  assert.ok(existsSync(join(to, 'app/js/config.js')));
  assert.ok(statSync(join(to, '.githooks/pre-commit')).mode & 0o100, 'hooks stay executable');
});

test('newApp refuses a bad id, an empty name, or a folder that is not empty', (t) => {
  const base = scratch(t);
  assert.throws(() => newApp({ from: CORE, to: join(base, 'a'), id: 'Trips!', name: 'T' }), /id/);
  assert.throws(() => newApp({ from: CORE, to: join(base, 'b'), id: 'trips', name: '  ' }), /name/);
  mkdirSync(join(base, 'full'));
  writeFileSync(join(base, 'full', 'keep.txt'), 'mine');
  assert.throws(() => newApp({ from: CORE, to: join(base, 'full'), id: 'trips', name: 'T' }), /not empty/);
  assert.equal(readFileSync(join(base, 'full', 'keep.txt'), 'utf8'), 'mine');
});

test('newApp with git sets up the repo hygiene', (t) => {
  const to = join(scratch(t), 'g');
  newApp({ from: CORE, to, id: 'gapp', name: 'G', git: true, email: 'someone@users.noreply.github.com' });
  const exclude = readFileSync(join(to, '.git/info/exclude'), 'utf8');
  for (const line of ['TASK.md', 'CLAUDE.local.md', '.local/']) assert.ok(exclude.split('\n').includes(line), line);
  const email = execFileSync('git', ['config', '--local', 'user.email'], { cwd: to, encoding: 'utf8' }).trim();
  assert.equal(email, 'someone@users.noreply.github.com');
  const hooks = execFileSync('git', ['config', '--local', 'core.hooksPath'], { cwd: to, encoding: 'utf8' }).trim();
  assert.equal(hooks, '.githooks', 'the git hooks are on');
  const log = execFileSync('git', ['status', '--porcelain'], { cwd: to, encoding: 'utf8' });
  assert.ok(log.length > 0, 'files are left uncommitted for a first commit by hand');
});

// Ports. Each app has its own port, and its tailnet HTTPS port uses the same
// number, so each app is its own origin with its own browser storage. A port
// counts as taken when another app's server/server.py claims it or
// `tailscale serve` uses it, never by what is listening now: apps are not
// always running.

/** @param {string} dir @param {Record<string, string>} files */
function put(dir, files) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
}

const noServe = () => null;

test('newApp --port writes the port into the launcher, which passes it to the core', (t) => {
  const to = join(scratch(t), 'ported');
  newApp({ from: CORE, to, id: 'ported', name: 'Ported', port: 9123, serveStatus: noServe });
  const py = readFileSync(join(to, 'server/server.py'), 'utf8');
  assert.match(py, /^PORT = 9123\b/m);
  assert.match(py, /port=PORT/);
});

test('without --port, newApp takes the lowest port from 8765 up that no app or tailscale serve claims', (t) => {
  const base = scratch(t);
  put(join(base, 'old'), { 'core.lock.json': '{}\n', 'server/server.py': 'from pwacore.server import main\n' }); // no PORT line: 8765
  put(join(base, 'second'), { 'core.lock.json': '{}\n', 'server/server.py': 'PORT = 8766  # set by new-app\n' });
  put(join(base, 'not-an-app'), { 'server/server.py': 'PORT = 8769\n' }); // no core.lock.json: no claim
  put(join(base, 'no-launcher'), { 'core.lock.json': '{}\n' }); // an app without a launcher claims 8765 too
  const serve = JSON.stringify({ TCP: { 8767: { HTTPS: true } }, Web: { 'm.t.ts.net:8767': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8768' } } } } });
  const to = join(base, 'next');
  newApp({ from: CORE, to, id: 'next', name: 'Next', serveStatus: () => serve });
  assert.match(readFileSync(join(to, 'server/server.py'), 'utf8'), /^PORT = 8769\b/m);
});

test('claimedPorts reads launchers and serve status, and ignores the folder being made', (t) => {
  const base = scratch(t);
  put(join(base, 'a'), { 'core.lock.json': '{}\n', 'server/server.py': '"""x"""\nPORT = 8800\n' });
  put(join(base, 'b'), { 'core.lock.json': '{}\n', 'server/server.py': 'PORT = 8801\n' });
  const claims = claimedPorts({ parent: base, self: join(base, 'b'), serveStatus: () => JSON.stringify({ TCP: { 443: { HTTPS: true } } }) });
  assert.deepEqual([...claims].sort(), [443, 8800]);
});

test('parseServeStatus finds every port in tailscale serve status --json', () => {
  const status = {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true }, 5432: { TCPForward: '127.0.0.1:5433' } },
    Web: {
      'm.t.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8765' } } },
      'm.t.ts.net:8443': { Handlers: { '/': { Proxy: 'http://localhost:8766/' }, '/x': { Path: '/tmp' } } },
    },
  };
  assert.deepEqual([...parseServeStatus(JSON.stringify(status))].sort((a, b) => a - b), [443, 5432, 5433, 8443, 8765, 8766]);
  assert.deepEqual([...parseServeStatus('{}')], []);
  assert.deepEqual([...parseServeStatus('')], [], 'nothing served');
  assert.deepEqual([...parseServeStatus(null)], [], 'tailscale not there');
  assert.throws(() => parseServeStatus('not json'), /tailscale serve status/);
});

test('pickPort skips claimed ports from 8765 up', () => {
  assert.equal(pickPort(new Set()), 8765);
  assert.equal(pickPort(new Set([8765, 8766, 8768])), 8767);
});

test('newApp refuses a bad port, or one another app already claims', (t) => {
  const base = scratch(t);
  put(join(base, 'old'), { 'core.lock.json': '{}\n', 'server/server.py': 'PORT = 8766\n' });
  for (const port of [0, 80, 1023, 65536, 8766.5, Number.NaN]) {
    assert.throws(() => newApp({ from: CORE, to: join(base, `p${port}`), id: 'pp', name: 'P', port, serveStatus: noServe }), /port/i, String(port));
  }
  assert.throws(() => newApp({ from: CORE, to: join(base, 'clash'), id: 'clash', name: 'Clash', port: 8766, serveStatus: noServe }), /8766 is taken/);
  assert.throws(() => newApp({ from: CORE, to: join(base, 'clash2'), id: 'clash', name: 'Clash', port: 8770, serveStatus: () => '{"TCP":{"8770":{"HTTPS":true}}}' }), /8770 is taken/);
  assert.ok(!existsSync(join(base, 'clash')), 'nothing is made when the port is refused');
});

test('the new-app command takes --port and prints the tailnet address on that port', (t) => {
  const base = scratch(t);
  const r = spawnSync(process.execPath, [join(CORE, 'tools/new-app.mjs'), join(base, 'cli'), '--id', 'cli', '--name', 'Cli', '--port', '9124'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(join(base, 'cli/server/server.py'), 'utf8'), /^PORT = 9124\b/m);
  assert.match(r.stdout, /port 9124/);
  assert.match(r.stdout, /tailscale serve --bg --https=9124 9124/);
  const bad = spawnSync(process.execPath, [join(CORE, 'tools/new-app.mjs'), join(base, 'cli2'), '--id', 'cli2', '--port', 'abc'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /port/i);
});
