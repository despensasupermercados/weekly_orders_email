// node test/run.mjs  (this is what `npm test` runs)
//
// It GLOBS the directory rather than listing files. `npm test` used to be
// "node test/parse.test.mjs" and nothing else: due, mime and watchdog all had
// tests, all passed, and none of them ran. A green `npm test` proved that one
// parser still worked and nothing more, which is worse than no test command at
// all because it reads as coverage. A hard-coded list drifts again the next
// time someone adds a file; a glob cannot.

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here).filter((f) => f.endsWith('.test.mjs')).sort();

if (!files.length) {
  console.error('no *.test.mjs files found - that is a failure, not a pass');
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [join(here, f)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed++;
    console.error(`FAIL ${f}`);
  }
}

console.log(`\n${files.length - failed} of ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
