import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findImports, checkApp, buildApp } from '../../tools/pwacore/build-lib.mjs';

test('findImports lists static, re-export and dynamic imports', () => {
  const src = `
    import { a } from './a.js';
    import './side.js';
    export { b } from "../core/b.js";
    export * from './c.js';
    const d = await import('./d.js');
    import x from 'https://example.com/x.js';
    // import { nope } from './commented.js';
  `;
  assert.deepEqual(findImports(src), ['./a.js', './side.js', '../core/b.js', './c.js', './d.js', 'https://example.com/x.js']);
});

/** @param {Record<string, string>} files */
function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pwacore-build-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const goodApp = {
  'app/index.html': '<script type="module" src="js/main.js"></script>',
  'app/js/main.js': "import { x } from '../core/x.js';\n",
  'app/core/x.js': 'export const x = 1;\n',
  'app/sw.js': "const ASSETS = [\n  './',\n  'core/x.js',\n  'index.html',\n  'js/main.js',\n];\n",
};

test('checkApp passes a sound app', (t) => {
  const dir = fixture(goodApp);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(checkApp(join(dir, 'app')), []);
});

test('checkApp finds a broken import, an import from outside app/, and a bare package name', (t) => {
  const dir = fixture({
    ...goodApp,
    'app/js/main.js': "import { x } from '../core/missing.js';\nimport '../../server/s.js';\nimport 'lodash';\n",
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const problems = checkApp(join(dir, 'app')).join('\n');
  assert.match(problems, /js\/main\.js imports \.\.\/core\/missing\.js, which does not exist/);
  assert.match(problems, /outside app/);
  assert.match(problems, /lodash.*no bundler/);
});

test('checkApp finds files the service worker would not cache, and stale entries', (t) => {
  const dir = fixture({ ...goodApp, 'app/js/extra.js': '', 'app/sw.js': "const ASSETS = [\n  './',\n  'index.html',\n  'js/main.js',\n  'js/gone.js',\n];\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const problems = checkApp(join(dir, 'app')).join('\n');
  assert.match(problems, /not in sw\.js ASSETS: core\/x\.js, js\/extra\.js/);
  assert.match(problems, /in sw\.js ASSETS but missing: js\/gone\.js/);
});

test('buildApp copies app/ to the output folder and skips dotfiles', (t) => {
  const dir = fixture({ ...goodApp, 'app/.DS_Store': 'junk' });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'dist');
  const result = buildApp(join(dir, 'app'), out);
  assert.deepEqual(result.problems, []);
  assert.equal(result.files, 4);
  assert.deepEqual(readdirSync(out).sort(), ['core', 'index.html', 'js', 'sw.js']);
});

test('buildApp writes nothing when the check fails', (t) => {
  const dir = fixture({ ...goodApp, 'app/js/main.js': "import './nope.js';\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = join(dir, 'dist');
  const result = buildApp(join(dir, 'app'), out);
  assert.equal(result.problems.length > 0, true);
  assert.throws(() => readdirSync(out));
});
