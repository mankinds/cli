/**
 * Drop `sourcesContent` from the committed Action bundle's source map.
 *
 * `dist/` lives in git and is checked out on every Action run. The map is
 * about 3.6 MB, of which 87 % is the embedded original source of the bundled
 * dependencies. That part is only ever used to print the offending source
 * line; the mappings alone are what turns a frame back into `src/action.ts`,
 * and they stay. Removing it takes the map to roughly 0.47 MB with stack
 * traces still resolving to the TypeScript.
 *
 * Deterministic, so `npm run verify-dist` and the CI check that `dist/` is in
 * sync still hold.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mapPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js.map");

const before = statSync(mapPath).size;
const map = JSON.parse(readFileSync(mapPath, "utf8"));

if (map.sourcesContent === undefined) {
  console.log("sourcemap: already stripped");
  process.exit(0);
}

delete map.sourcesContent;
writeFileSync(mapPath, JSON.stringify(map));

const after = statSync(mapPath).size;
const saved = ((before - after) / 1024 / 1024).toFixed(2);
console.log(`sourcemap: ${(before / 1024 / 1024).toFixed(2)} MB -> ${(after / 1024 / 1024).toFixed(2)} MB (-${saved} MB)`);
