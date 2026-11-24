// npm run lint: ESLint on the JS (eslint.config.js), then ruff on the Python,
// lint and format check (ruff.toml). Every step runs, so one run shows all
// the problems.
//
//   node tools/pwacore/lint.mjs                 # the whole app
//   node tools/pwacore/lint.mjs --files0 <file> # only the files listed in
//                                               # <file>, NUL-separated (the
//                                               # pre-commit hook's staged list)
//
// ruff runs through uv (`uvx ruff@<version>`), so the version is pinned here
// and nothing is installed globally. The first run downloads it into uv's
// cache.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const RUFF_VERSION = '0.17.4';

const root = fileURLToPath(new URL('../..', import.meta.url));
const JS = /\.(?:js|mjs|cjs)$/;
const PY = /\.py$/;

/** @typedef {{ name: string, cmd: string, args: string[] }} Step */

/** @param {string[] | null} files null means the whole app @returns {Step[]} */
export function lintPlan(files) {
  const eslint = { name: 'eslint', cmd: process.execPath, args: [join(root, 'node_modules/eslint/bin/eslint.js')] };
  /** @param {string} name @param {string[]} args @returns {Step} */
  const ruff = (name, args) => ({ name, cmd: 'uvx', args: [`ruff@${RUFF_VERSION}`, ...args] });
  if (files === null) {
    return [
      { ...eslint, args: [...eslint.args, '.'] },
      ruff('ruff check', ['check']),
      ruff('ruff format', ['format', '--check']),
    ];
  }
  const js = files.filter((f) => JS.test(f));
  const py = files.filter((f) => PY.test(f));
  /** @type {Step[]} */
  const plan = [];
  // Explicit paths would skip the configs' ignore lists without these flags.
  if (js.length) plan.push({ ...eslint, args: [...eslint.args, '--no-warn-ignored', ...js] });
  if (py.length) {
    plan.push(ruff('ruff check', ['check', '--force-exclude', '--', ...py]));
    plan.push(ruff('ruff format', ['format', '--check', '--force-exclude', '--', ...py]));
  }
  return plan;
}

/**
 * @typedef {object} RunDeps
 * @property {(cmd: string, args: string[]) => number | null} [exec] exit status, or null when cmd is not installed
 * @property {(msg: string) => void} [log]
 */

/** @param {string} cmd @param {string[]} args @returns {number | null} */
function exec(cmd, args) {
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.error) {
    if (/** @type {NodeJS.ErrnoException} */ (res.error).code === 'ENOENT') return null;
    throw res.error;
  }
  return res.status ?? 1;
}

/** @param {Step[]} plan @param {RunDeps} [deps] @returns {number} exit code */
export function runLint(plan, { exec: run = exec, log = console.error } = {}) {
  let failed = 0;
  for (const step of plan) {
    const status = run(step.cmd, step.args);
    if (status === null) {
      log(`lint: ${step.cmd} not found. ruff runs through uv: install it (https://docs.astral.sh/uv/), then run lint again.`);
      failed++;
    } else if (status !== 0) {
      log(`lint: ${step.name} failed.`);
      failed++;
    }
  }
  return failed ? 1 : 0;
}

/** @param {string} text a NUL-separated list, as `git diff --name-only -z` writes it */
export const parseFileList = (text) => text.split('\0').filter(Boolean);

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  /** @type {string[] | null} */
  let files = null;
  if (args[0] === '--files0' && args.length === 2) files = parseFileList(readFileSync(args[1], 'utf8'));
  else if (args.length) {
    console.error('Usage: node tools/pwacore/lint.mjs [--files0 <file>]');
    process.exit(2);
  }
  process.exit(runLint(lintPlan(files)));
}
