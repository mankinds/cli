import { describe, expect, it, vi } from "vitest";

import type { AgentRun, MankindsClient } from "../src/api.js";
import { waitForRun } from "../src/poll.js";

function makeClient(responses: Array<Partial<AgentRun> | Error>): MankindsClient {
  let i = 0;
  return {
    getRun: vi.fn(async () => {
      const r = responses[i++];
      if (r instanceof Error) throw r;
      return r as AgentRun;
    }),
  } as unknown as MankindsClient;
}

describe("waitForRun", () => {
  it("returns the run when status reaches completed", async () => {
    const client = makeClient([
      { status: "running" },
      { status: "completed", id: "abc", results: { gate: { passed: true } } },
    ]);
    const result = await waitForRun({
      client,
      agent: "a",
      runId: "abc",
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });
    expect(result?.status).toBe("completed");
  });

  it("retries up to 3 times on transient errors", async () => {
    const client = makeClient([
      new Error("502 Bad Gateway"),
      new Error("502 Bad Gateway"),
      { status: "completed", id: "abc" },
    ]);
    const result = await waitForRun({
      client,
      agent: "a",
      runId: "abc",
      timeoutMs: 60_000,
      pollIntervalMs: 1,
    });
    expect(result?.status).toBe("completed");
  });

  it("bubbles up after 3 consecutive errors", async () => {
    const client = makeClient([
      new Error("502"),
      new Error("502"),
      new Error("502"),
    ]);
    await expect(
      waitForRun({
        client,
        agent: "a",
        runId: "abc",
        timeoutMs: 60_000,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow("502");
  });

  it("returns null on timeout", async () => {
    const client = makeClient(Array(100).fill({ status: "running" }));
    const result = await waitForRun({
      client,
      agent: "a",
      runId: "abc",
      timeoutMs: 5,
      pollIntervalMs: 1,
    });
    expect(result).toBeNull();
  });
});
