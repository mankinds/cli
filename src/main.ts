/**
 * Mankinds CI runner entry point.
 *
 * Detects whether the process is running inside a GitHub Action
 * (GITHUB_ACTIONS=true) and dispatches to either the GHA-specific
 * handler (uses @actions/core for inputs, outputs, summary, PR
 * comment via @actions/github) or the generic CLI handler (reads
 * argv / env, prints to stdout). The two paths share the exact same
 * API client, polling loop, and summary renderer.
 */

import { runAction } from "./action.js";
import { runCli } from "./cli.js";

async function main(): Promise<number> {
  if (process.env.GITHUB_ACTIONS === "true") {
    return runAction();
  }
  return runCli(process.argv.slice(2));
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[mankinds] fatal:", err);
    process.exit(2);
  });
