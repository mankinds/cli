/**
 * Block until the run reaches a terminal status or the timeout
 * fires. Network blips are retried up to 3 times in a row before
 * bubbling up: a flaky proxy must not block a 20-minute eval over
 * a single 502.
 */

import type { AgentRun, MankindsClient } from "./api.js";

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "canceled",
  "timeout",
]);

export interface WaitForRunOpts {
  client: MankindsClient;
  agent: string;
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  onLog?: (msg: string) => void;
}

export async function waitForRun(opts: WaitForRunOpts): Promise<AgentRun | null> {
  const { client, agent, runId, timeoutMs, pollIntervalMs } = opts;
  const log = opts.onLog ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    let run: AgentRun;
    try {
      run = await client.getRun(agent, runId);
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      log(`poll error (${consecutiveFailures}/3): ${(err as Error).message}`);
      if (consecutiveFailures >= 3) {
        throw err;
      }
      await sleep(pollIntervalMs);
      continue;
    }

    const status = run.status ?? "unknown";
    if (TERMINAL_STATUSES.has(status)) {
      log(`run reached terminal status: ${status}`);
      return run;
    }
    log(`status=${status}, waiting ${pollIntervalMs / 1000}s`);
    await sleep(pollIntervalMs);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
