/**
 * Thin HTTP client over the Mankinds agents endpoint.
 *
 * Uses node:undici for zero extra runtime weight (Node 20+ ships
 * it built-in). The class is the only place that knows the wire
 * format; callers manipulate typed AgentRun objects everywhere
 * else.
 */

import { request } from "undici";

export interface TriggerOptions {
  triggerSource: string;
  triggerMetadata: Record<string, unknown>;
}

export interface GateResult {
  passed?: boolean;
  is_warning?: boolean;
  overall_score?: number;
  overall_score_min?: number;
  failures?: string[];
}

export interface AgentRun {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "timeout";
  results?: { gate?: GateResult };
  [key: string]: unknown;
}

export class MankindsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: { baseUrl: string; apiKey: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  async triggerRun(agent: string, opts: TriggerOptions): Promise<string> {
    const { statusCode, body } = await request(
      `${this.baseUrl}/api/agents/${encodeURIComponent(agent)}/runs`,
      {
        method: "POST",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
          "User-Agent": "mankinds-cli/1.0",
        },
        body: JSON.stringify({
          trigger_source: opts.triggerSource,
          trigger_metadata: opts.triggerMetadata,
        }),
      },
    );

    const text = await body.text();
    if (statusCode !== 200) {
      throw new Error(`trigger failed (HTTP ${statusCode}): ${parseDetail(text)}`);
    }
    const json = safeJson(text);
    if (!json || typeof json.id !== "string") {
      throw new Error("trigger response missing 'id' field");
    }
    return json.id;
  }

  async getRun(agent: string, runId: string): Promise<AgentRun> {
    const { statusCode, body } = await request(
      `${this.baseUrl}/api/agents/${encodeURIComponent(agent)}/runs/${encodeURIComponent(runId)}`,
      {
        method: "GET",
        headers: {
          "X-API-Key": this.apiKey,
          "User-Agent": "mankinds-cli/1.0",
        },
      },
    );

    const text = await body.text();
    if (statusCode !== 200) {
      throw new Error(`get_run failed (HTTP ${statusCode}): ${parseDetail(text)}`);
    }
    const json = safeJson(text);
    if (!json) {
      throw new Error("get_run returned invalid JSON");
    }
    return json as AgentRun;
  }
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseDetail(text: string): string {
  const json = safeJson(text);
  if (json && typeof json === "object") {
    const detail = (json as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const obj = detail as Record<string, unknown>;
      const t = obj.type ?? obj.message;
      if (typeof t === "string") return t;
    }
  }
  return text.slice(0, 500);
}
