// npm run build: check the app and copy it to dist/ for static hosting.
// The Python server serves app/ directly, so you only need dist/ to host
// the app somewhere else.
import { fileURLToPath } from 'node:url';
import { buildApp } from './build-lib.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { problems, files } = buildApp(`${root}app`, `${root}dist`);
if (problems.length) {
  console.error(`Build failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Built ${files} files into dist/`);
