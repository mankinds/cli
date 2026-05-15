/**
 * Generic CLI adapter for non-GitHub CIs (GitLab, CircleCI, Jenkins,
 * Bitbucket Pipelines, local dev). Reads options from argv / env
 * vars instead of @actions/core, prints plain text to stdout. Same
 * engine as the GHA path (./action.ts). Shipped inside the
 * ghcr.io/mankinds/ci Docker image via the bin entry in
 * package.json (`mankinds-ci`).
 */

import { parseArgs } from "node:util";

import { MankindsClient } from "./api.js";
import { collectTriggerMetadata, detectProvider } from "./trigger.js";
import { waitForRun } from "./poll.js";
import { renderTextSummary } from "./summary.js";
import { EXIT_GATE_FAILED, EXIT_INFRA_ERROR, EXIT_OK } from "./exit_codes.js";

export async function runCli(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agent: { type: "string" },
      "api-key": { type: "string" },
      "base-url": { type: "string", default: "https://app.mankinds.io" },
      "timeout-minutes": { type: "string", default: "30" },
      "poll-interval": { type: "string", default: "15" },
      "ci-provider": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return EXIT_OK;
  }

  const agent = values.agent;
  const apiKey = values["api-key"] ?? process.env.MANKINDS_API_KEY;
  const baseUrl =
    values["base-url"] ?? process.env.MANKINDS_BASE_URL ?? "https://app.mankinds.io";
  const timeoutMinutes = parseInt(values["timeout-minutes"] ?? "30", 10);
  const pollIntervalSec = parseInt(values["poll-interval"] ?? "15", 10);
  const ciProvider = values["ci-provider"] ?? detectProvider();

  if (!agent || !apiKey) {
    console.error("Missing --agent or --api-key (or MANKINDS_API_KEY env var).");
    printHelp();
    return EXIT_INFRA_ERROR;
  }

  console.log(`[mankinds] Triggering run on agent '${agent}' at ${baseUrl}`);

  const client = new MankindsClient({ baseUrl, apiKey });
  const triggerMetadata = collectTriggerMetadata(ciProvider);

  let runId: string;
  try {
    runId = await client.triggerRun(agent, {
      triggerSource: ciProvider,
      triggerMetadata,
    });
  } catch (err) {
    console.error(`[mankinds] trigger failed: ${(err as Error).message}`);
    return EXIT_INFRA_ERROR;
  }

  console.log(`[mankinds] Run created: ${runId}`);

  const run = await waitForRun({
    client,
    agent,
    runId,
    timeoutMs: timeoutMinutes * 60 * 1000,
    pollIntervalMs: pollIntervalSec * 1000,
    onLog: (msg) => console.log(`[mankinds] ${msg}`),
  });

  if (run === null) {
    console.error(`[mankinds] run did not complete within ${timeoutMinutes}m`);
    return EXIT_INFRA_ERROR;
  }

  const gate = run.results?.gate ?? {};
  console.log(renderTextSummary({ runId, run, gate }));

  if (gate.passed === true) {
    return EXIT_OK;
  }
  return EXIT_GATE_FAILED;
}

function printHelp(): void {
  console.log(`mankinds-ci --agent <name> [--api-key <key>] [--base-url <url>]
              [--timeout-minutes 30] [--poll-interval 15]
              [--ci-provider github_actions|gitlab_ci|...]

Triggers a Mankinds agent run, polls until completion, prints the
scorecard verdict, and exits 0 (gate passed) / 1 (gate failed) / 2
(infrastructure error). API key is read from --api-key or the
MANKINDS_API_KEY env var.
`);
}
