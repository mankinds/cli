/**
 * The redaction rule. The runner holds the rendered credentials in clear, so
 * these tests exist to make the leak path a failing test rather than a code
 * review habit.
 */

import { describe, expect, it } from "vitest";

import { safeErrorDetail, safeRequestLabel } from "../src/runner/log.js";

describe("safeRequestLabel", () => {
  it("keeps the method and the path", () => {
    expect(safeRequestLabel("post", "http://localhost:3000/api/chat")).toBe("POST /api/chat");
  });

  it("never prints the query string, which can carry a credential", () => {
    const label = safeRequestLabel("GET", "http://localhost:3000/api?api_key=sk-secret-value");
    expect(label).not.toContain("sk-secret-value");
    expect(label).not.toContain("api_key");
    expect(label).toBe("GET /api?…");
  });

  it("never prints userinfo", () => {
    const label = safeRequestLabel("GET", "http://user:hunter2@localhost:3000/api");
    expect(label).not.toContain("hunter2");
    expect(label).not.toContain("user");
  });

  it("never prints the fragment", () => {
    expect(safeRequestLabel("GET", "http://localhost:3000/api#token=abc")).toBe("GET /api");
  });

  it("degrades safely on an unparseable url", () => {
    expect(safeRequestLabel("GET", "¯\\_(ツ)_/¯")).toBe("GET ?");
  });

  it("does not let a crafted method smuggle text into the log", () => {
    const label = safeRequestLabel("GET\n[mankinds] Bearer sk-leak", "http://localhost:3000/");
    expect(label).not.toContain("sk-leak");
    expect(label).not.toContain("\n");
  });
});

describe("safeErrorDetail", () => {
  it("prefers the stable error code", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
      code: "ECONNREFUSED",
    });
    expect(safeErrorDetail(error)).toBe("ECONNREFUSED");
  });

  it("never returns a free-form message, which could carry a url with a token", () => {
    const error = new Error("failed to fetch http://localhost:3000/api?key=sk-secret");
    expect(safeErrorDetail(error)).not.toContain("sk-secret");
  });

  it("falls back to the error name, then to a constant", () => {
    expect(safeErrorDetail(new DOMException("x", "TimeoutError"))).toBe("TimeoutError");
    expect(safeErrorDetail("a bare string")).toBe("unknown error");
    expect(safeErrorDetail(null)).toBe("unknown error");
  });
});
