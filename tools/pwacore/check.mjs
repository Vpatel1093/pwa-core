// npm run check: static checks, separate from the tests. Every JS file must
// parse (node --check), every Python file must compile, and every JSON file
// must parse. Lint (npm run lint: ESLint and ruff, see lint.mjs) and the
// type check (npm run typecheck: tsc reads the JSDoc types, see
// tsconfig.json) are separate, and npm run check runs them after this.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listFiles } from './build-lib.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const files = ['app', 'test', 'tools', 'server'].flatMap((d) => listFiles(join(root, d)).map((f) => join(d, f)));
/** @type {string[]} */
const problems = [];
/** @param {unknown} err */
const stderrOf = (err) => String(/** @type {{ stderr?: unknown }} */ (err).stderr).trim();

for (const f of files.filter((x) => /\.m?js$/.test(x))) {
  try {
    execFileSync(process.execPath, ['--check', join(root, f)], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${f}: ${stderrOf(err).split('\n').slice(0, 5).join('\n    ')}`);
  }
}

const py = files.filter((x) => x.endsWith('.py') && !x.includes('__pycache__'));
if (py.length) {
  // compile() without writing .pyc files.
  const script = 'import sys\nfor p in sys.argv[1:]:\n    compile(open(p, encoding="utf-8").read(), p, "exec")';
  try {
    execFileSync('python3', ['-c', script, ...py.map((f) => join(root, f))], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`python: ${stderrOf(err).split('\n').slice(-3).join('\n    ')}`);
  }
}

for (const f of [...files.filter((x) => x.endsWith('.json') || x.endsWith('.webmanifest')), 'package.json']) {
  try {
    JSON.parse(readFileSync(join(root, f), 'utf8'));
  } catch (err) {
    problems.push(`${f}: ${/** @type {Error} */ (err).message}`);
  }
}

if (problems.length) {
  console.error(`Check failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Checked ${files.length + 1} files: JS parses, Python compiles, JSON parses.`);
