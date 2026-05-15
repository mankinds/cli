import { describe, expect, it } from "vitest";

import type { AgentRun, GateResult } from "../src/api.js";
import {
  STICKY_COMMENT_MARKER,
  renderJobSummary,
  renderStickyComment,
  renderTextSummary,
} from "../src/summary.js";

const run: AgentRun = { id: "abc", status: "completed" };

describe("renderJobSummary", () => {
  it("renders the OK header when the gate passed and is not a warning", () => {
    const gate: GateResult = {
      passed: true,
      is_warning: false,
      overall_score: 0.9,
      overall_score_min: 0.8,
      failures: [],
    };
    const out = renderJobSummary({ runId: "abc", run, gate });

    expect(out).toContain("## Mankinds quality gate");
    expect(out).not.toContain("## Mankinds quality gate (warning)");
    expect(out).not.toContain("## Mankinds quality gate failed");
    expect(out).toContain("0.900");
    expect(out).toContain("0.800");
    expect(out).toContain("`abc`");
    expect(out).not.toContain("### Failures");
  });

  it("renders the warning header when the gate passed with is_warning=true", () => {
    const gate: GateResult = {
      passed: true,
      is_warning: true,
      overall_score: 0.85,
      overall_score_min: 0.8,
    };
    const out = renderJobSummary({ runId: "abc", run, gate });

    expect(out).toContain("## Mankinds quality gate (warning)");
  });

  it("renders the failed header and lists failures as bullets when the gate failed", () => {
    const gate: GateResult = {
      passed: false,
      overall_score: 0.5,
      overall_score_min: 0.8,
      failures: ["accuracy below threshold", "latency p95 too high"],
    };
    const out = renderJobSummary({ runId: "abc", run, gate });

    expect(out).toContain("## Mankinds quality gate failed");
    expect(out).toContain("### Failures");
    expect(out).toContain("- accuracy below threshold");
    expect(out).toContain("- latency p95 too high");
  });

  it("includes the 'Open scorecard in Mankinds' link when baseUrl is passed", () => {
    const gate: GateResult = { passed: true, overall_score: 0.9, overall_score_min: 0.8 };
    const out = renderJobSummary({
      runId: "abc",
      run,
      gate,
      baseUrl: "https://app.mankinds.io",
    });

    expect(out).toContain("[Open scorecard in Mankinds](https://app.mankinds.io/agents)");
  });

  it("omits the scorecard link when baseUrl is not provided", () => {
    const gate: GateResult = { passed: true, overall_score: 0.9, overall_score_min: 0.8 };
    const out = renderJobSummary({ runId: "abc", run, gate });

    expect(out).not.toContain("Open scorecard in Mankinds");
  });
});

describe("renderStickyComment", () => {
  it("starts with the STICKY_COMMENT_MARKER", () => {
    const gate: GateResult = { passed: true, overall_score: 0.9, overall_score_min: 0.8 };
    const out = renderStickyComment({ runId: "abc", run, gate });

    expect(out.startsWith(STICKY_COMMENT_MARKER)).toBe(true);
  });
});

describe("renderTextSummary", () => {
  it("uses the OK header when passed and not a warning", () => {
    const gate: GateResult = {
      passed: true,
      is_warning: false,
      overall_score: 0.9,
      overall_score_min: 0.8,
    };
    const out = renderTextSummary({ runId: "abc", run, gate });

    expect(out).toContain("Mankinds quality gate OK");
    expect(out).not.toContain("WARNING");
    expect(out).not.toContain("FAILED");
  });

  it("uses the WARNING header when passed with is_warning=true", () => {
    const gate: GateResult = {
      passed: true,
      is_warning: true,
      overall_score: 0.85,
      overall_score_min: 0.8,
    };
    const out = renderTextSummary({ runId: "abc", run, gate });

    expect(out).toContain("Mankinds quality gate WARNING");
  });

  it("uses the FAILED header when the gate did not pass", () => {
    const gate: GateResult = {
      passed: false,
      overall_score: 0.5,
      overall_score_min: 0.8,
    };
    const out = renderTextSummary({ runId: "abc", run, gate });

    expect(out).toContain("Mankinds quality gate FAILED");
  });

  it("includes a 'Failures:' bullet list when failures is non-empty", () => {
    const gate: GateResult = {
      passed: false,
      overall_score: 0.5,
      overall_score_min: 0.8,
      failures: ["accuracy below threshold", "latency p95 too high"],
    };
    const out = renderTextSummary({ runId: "abc", run, gate });

    expect(out).toContain("Failures:");
    expect(out).toContain("  - accuracy below threshold");
    expect(out).toContain("  - latency p95 too high");
  });

  it("omits the failures section when failures is empty", () => {
    const gate: GateResult = {
      passed: true,
      overall_score: 0.9,
      overall_score_min: 0.8,
      failures: [],
    };
    const out = renderTextSummary({ runId: "abc", run, gate });

    expect(out).not.toContain("Failures:");
  });
});
