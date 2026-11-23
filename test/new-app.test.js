import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLock } from '../tools/pwacore/lock.mjs';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newApp } from '../tools/new-app.mjs';

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
  const log = execFileSync('git', ['status', '--porcelain'], { cwd: to, encoding: 'utf8' });
  assert.ok(log.length > 0, 'files are left uncommitted for a first commit by hand');
});
