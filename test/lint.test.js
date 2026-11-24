import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUFF_VERSION, lintPlan, runLint, parseFileList } from '../tools/pwacore/lint.mjs';

const ruff = ['uvx', `ruff@${RUFF_VERSION}`];

test('with no file list, lint runs ESLint and both ruff checks on the whole app', () => {
  const plan = lintPlan(null);
  assert.deepEqual(plan.map((s) => s.name), ['eslint', 'ruff check', 'ruff format']);
  assert.deepEqual(plan[0].args.slice(-1), ['.']);
  assert.deepEqual([plan[1].cmd, ...plan[1].args], [...ruff, 'check']);
  assert.deepEqual([plan[2].cmd, ...plan[2].args], [...ruff, 'format', '--check']);
});

test('with a file list, each tool gets only its own files, and ignored files stay ignored', () => {
  const plan = lintPlan(['app/a.js', 'tools/b.mjs', 'server/c.py', 'README.md', 'app/css/app.css']);
  assert.deepEqual(plan.map((s) => s.name), ['eslint', 'ruff check', 'ruff format']);
  assert.deepEqual(plan[0].args.slice(-3), ['--no-warn-ignored', 'app/a.js', 'tools/b.mjs']);
  assert.deepEqual(plan[1].args.slice(-3), ['--force-exclude', '--', 'server/c.py']);
  assert.deepEqual(plan[2].args.slice(-3), ['--force-exclude', '--', 'server/c.py']);
});

test('a file list with nothing to lint runs nothing', () => {
  assert.deepEqual(lintPlan(['README.md', 'app/icons/icon.svg']), []);
  assert.deepEqual(lintPlan([]), []);
  assert.deepEqual(lintPlan(['x.py']).map((s) => s.name), ['ruff check', 'ruff format']);
});

test('runLint runs every step, reports each failure and fails if any step fails', () => {
  /** @type {string[]} */
  const ran = [];
  /** @type {string[]} */
  const said = [];
  const code = runLint(lintPlan(null), {
    exec: (cmd, args) => { ran.push(args.includes('format') ? 'format' : cmd); return args.includes('check') && !args.includes('format') ? 1 : 0; },
    log: (msg) => said.push(msg),
  });
  assert.equal(code, 1);
  assert.equal(ran.length, 3);
  assert.match(said.join('\n'), /ruff check failed/);
  assert.equal(runLint(lintPlan(null), { exec: () => 0, log: () => {} }), 0);
});

test('a tool that is not installed fails with a hint, not a crash', () => {
  /** @type {string[]} */
  const said = [];
  const code = runLint(lintPlan(['x.py']), { exec: () => null, log: (m) => said.push(m) });
  assert.equal(code, 1);
  assert.match(said.join('\n'), /uvx.*not found.*uv/s);
});

test('parseFileList reads a NUL-separated list, as git -z writes it', () => {
  assert.deepEqual(parseFileList('a.js\0dir/b c.py\0'), ['a.js', 'dir/b c.py']);
  assert.deepEqual(parseFileList(''), []);
});
