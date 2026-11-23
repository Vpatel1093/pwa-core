// What `npm run build` checks and does. There is no bundler: the app ships
// as plain ES modules. The build catches what a bundler would have caught
// (an import of a file that isn't there) plus what the offline shell needs
// (every file listed in sw.js), then copies app/ to an output folder for
// static hosting.

import { readFileSync, readdirSync, statSync, existsSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, relative, dirname, resolve, sep } from 'node:path';

const PATTERNS = [
  /\bimport\s+(?:[\w$*{}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bexport\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

/** @param {string} src */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Module specifiers in source order.
/** @param {string} src */
export function findImports(src) {
  const code = stripComments(src);
  /** @type {[number, string][]} */
  const found = [];
  for (const re of PATTERNS) for (const m of code.matchAll(re)) found.push([m.index, m[1]]);
  return found.sort((a, b) => a[0] - b[0]).map(([, spec]) => spec);
}

// Every file under dir as a '/'-separated relative path, dotfiles left out.
/** @param {string} dir @param {string} [base] @returns {string[]} */
export function listFiles(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith('.')) return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).split(sep).join('/')];
  }).sort();
}

/** @param {string} s */
const isUrl = (s) => /^[a-z]+:\/\//i.test(s);

// Returns a list of problems; empty means the app is sound.
/** @param {string} appDir */
export function checkApp(appDir) {
  const root = resolve(appDir);
  const files = listFiles(root);
  const problems = [];
  for (const file of files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    for (const spec of findImports(readFileSync(join(root, file), 'utf8'))) {
      if (isUrl(spec)) continue;
      if (!spec.startsWith('.') && !spec.startsWith('/')) {
        problems.push(`${file} imports ${spec}: no bundler here, so import files by relative path`);
        continue;
      }
      const target = resolve(dirname(join(root, file)), spec);
      if (!target.startsWith(root + sep)) problems.push(`${file} imports ${spec}, which is outside app/`);
      else if (!existsSync(target)) problems.push(`${file} imports ${spec}, which does not exist`);
    }
  }
  if (files.includes('sw.js')) {
    const sw = readFileSync(join(root, 'sw.js'), 'utf8');
    const listed = new Set([...sw.matchAll(/^\s+'([^']+)',$/gm)].map((m) => m[1]));
    const missing = files.filter((f) => f !== 'sw.js' && !listed.has(f));
    const stale = [...listed].filter((f) => f !== './' && !files.includes(f));
    if (missing.length) problems.push(`not in sw.js ASSETS: ${missing.join(', ')}`);
    if (stale.length) problems.push(`in sw.js ASSETS but missing: ${stale.join(', ')}`);
  }
  return problems;
}

// Check, then copy app/ to outDir (replacing it). Nothing is written if the
// check fails.
/** @param {string} appDir @param {string} outDir */
export function buildApp(appDir, outDir) {
  const problems = checkApp(appDir);
  if (problems.length) return { problems, files: 0 };
  const files = listFiles(appDir);
  rmSync(outDir, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(dirname(join(outDir, f)), { recursive: true });
    copyFileSync(join(appDir, f), join(outDir, f));
  }
  return { problems, files: files.length };
}
