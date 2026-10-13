#!/usr/bin/env node
/**
 * `mankinds-ci` as installed from npm.
 *
 * The Action and the Docker image both run the ncc bundle at `dist/index.js`,
 * which is not shipped in the npm tarball: it carries the Octokit stack, and
 * nobody installing the package from npm should pay for it. This entry gives
 * the same CLI from the compiled sources, with `undici` as its only runtime
 * dependency.
 */

import { runCli } from "./cli.js";
import { EXIT_INFRA_ERROR } from "./exit_codes.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[mankinds] fatal:", error);
    process.exitCode = EXIT_INFRA_ERROR;
  });
