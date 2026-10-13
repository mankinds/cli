#!/usr/bin/env node
/**
 * Executable of the published npm package: `npx @mankinds/cli <command>`,
 * or `mankinds <command>` once installed.
 *
 * Deliberately empty of logic. Every command is loaded lazily by
 * {@link runBin}, so running `doctor` or `ci` never pulls in the sealing
 * stack that only `dev` needs.
 */

import { runBin } from "./commands.js";
import { EXIT_INFRA_ERROR } from "./exit_codes.js";

runBin(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[mankinds] fatal:", error);
    process.exitCode = EXIT_INFRA_ERROR;
  });
