/**
 * Renderers for the three surfaces where the scorecard verdict is
 * shown: the GHA job summary (markdown), the sticky PR comment
 * (markdown with a marker), and the plain-text CLI output for
 * non-GHA CIs.
 */

import type { AgentRun, GateResult } from "./api.js";

export interface RenderArgs {
  runId: string;
  run: AgentRun;
  gate: GateResult;
  baseUrl?: string;
}

export const STICKY_COMMENT_MARKER = "<!-- mankinds-quality-gate -->";

export function renderJobSummary({ runId, gate, baseUrl }: RenderArgs): string {
  const header = headerFor(gate);
  const score = gate.overall_score ?? 0;
  const threshold = gate.overall_score_min ?? 0;
  const failures = gate.failures ?? [];

  const lines = [
    `## ${header}`,
    "",
    `**Score:** ${score.toFixed(3)} (threshold ${threshold.toFixed(3)})`,
    `**Run ID:** \`${runId}\``,
  ];

  if (failures.length > 0) {
    lines.push("", "### Failures", "", ...failures.map((f) => `- ${f}`));
  }

  if (baseUrl) {
    lines.push("", `[Open scorecard in Mankinds](${baseUrl}/agents)`);
  }

  return lines.join("\n");
}

export function renderStickyComment(args: RenderArgs): string {
  return `${STICKY_COMMENT_MARKER}\n${renderJobSummary(args)}`;
}

export function renderTextSummary({ runId, gate }: RenderArgs): string {
  const passed = Boolean(gate.passed);
  const isWarning = Boolean(gate.is_warning);
  const overall = gate.overall_score ?? 0;
  const threshold = gate.overall_score_min ?? 0;
  const failures = gate.failures ?? [];

  let header: string;
  if (passed && !isWarning) header = "Mankinds quality gate OK";
  else if (passed && isWarning) header = "Mankinds quality gate WARNING";
  else header = "Mankinds quality gate FAILED";

  const lines = [
    "",
    header,
    `Score: ${overall.toFixed(3)} (threshold ${threshold.toFixed(3)})`,
    `Run: ${runId}`,
  ];

  if (failures.length > 0) {
    lines.push("Failures:");
    for (const f of failures) {
      lines.push(`  - ${f}`);
    }
  }
  return lines.join("\n");
}

function headerFor(gate: GateResult): string {
  if (gate.passed && !gate.is_warning) return "Mankinds quality gate";
  if (gate.passed && gate.is_warning) return "Mankinds quality gate (warning)";
  return "Mankinds quality gate failed";
}
