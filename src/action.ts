/**
 * GitHub Actions adapter: read inputs/outputs via @actions/core,
 * write a rich job summary, post a sticky PR comment via Octokit
 * when the workflow runs on pull_request. Zero business logic: the
 * actual flow (trigger run, poll, compute verdict) lives in the
 * shared modules below and is reused by the Docker CLI (./cli.ts).
 */

import * as core from "@actions/core";
import * as github from "@actions/github";

import { MankindsClient } from "./api.js";
import { collectTriggerMetadata } from "./trigger.js";
import { waitForRun } from "./poll.js";
import { renderJobSummary, renderStickyComment } from "./summary.js";
import { upsertStickyComment } from "./pr_comment.js";
import { EXIT_GATE_FAILED, EXIT_INFRA_ERROR, EXIT_OK } from "./exit_codes.js";

export async function runAction(): Promise<number> {
  const agent = core.getInput("agent", { required: true });
  const apiKey = core.getInput("api-key", { required: true });
  const baseUrl = core.getInput("base-url") || "https://app.mankinds.io";
  const timeoutMinutes = parseInt(core.getInput("timeout-minutes") || "30", 10);
  const commentOnPr = (core.getInput("comment-on-pr") || "true") === "true";

  core.info(`Triggering run on agent '${agent}' at ${baseUrl}`);

  const client = new MankindsClient({ baseUrl, apiKey });
  const triggerMetadata = collectTriggerMetadata("github_actions");

  let runId: string;
  try {
    runId = await client.triggerRun(agent, {
      triggerSource: "github_actions",
      triggerMetadata,
    });
  } catch (err) {
    core.setFailed(`Mankinds trigger failed: ${(err as Error).message}`);
    return EXIT_INFRA_ERROR;
  }

  core.info(`Run created: ${runId}`);
  core.setOutput("run-id", runId);

  const run = await waitForRun({
    client,
    agent,
    runId,
    timeoutMs: timeoutMinutes * 60 * 1000,
    pollIntervalMs: 15_000,
    onLog: (msg) => core.info(msg),
  });

  if (run === null) {
    core.setFailed(`Mankinds run did not complete within ${timeoutMinutes}m`);
    return EXIT_INFRA_ERROR;
  }

  const gate = run.results?.gate ?? {};
  core.setOutput("score", String(gate.overall_score ?? 0));
  core.setOutput("gate-passed", String(Boolean(gate.passed)));

  await core.summary
    .addRaw(renderJobSummary({ runId, run, gate, baseUrl }))
    .write();

  if (commentOnPr && github.context.eventName === "pull_request") {
    try {
      await upsertStickyComment(
        github.getOctokit(process.env.GITHUB_TOKEN ?? ""),
        renderStickyComment({ runId, run, gate, baseUrl }),
      );
    } catch (err) {
      core.warning(`Sticky PR comment failed (non-blocking): ${(err as Error).message}`);
    }
  }

  if (gate.passed === true) {
    return EXIT_OK;
  }
  return EXIT_GATE_FAILED;
}
