/**
 * The membership rule. This is the guardrail that replaces the server side
 * network policy on this transport, so its refusals are tested as carefully
 * as its acceptances.
 */

import { describe, expect, it } from "vitest";

import { canonicalHost, isAllowed, parseTarget, TargetError } from "../src/runner/target.js";

const target = parseTarget("http://localhost:3000");

function allowed(url: string, against = target): boolean {
  return isAllowed(new URL(url), against);
}

describe("parseTarget", () => {
  it("accepts a bare origin", () => {
    expect(parseTarget("http://localhost:3000")).toMatchObject({
      scheme: "http",
      host: "localhost",
      port: 3000,
    });
  });

  it("accepts an origin with a trailing slash", () => {
    expect(parseTarget("http://localhost:3000/").port).toBe(3000);
  });

  it("fills in the scheme default port", () => {
    expect(parseTarget("http://localhost").port).toBe(80);
    expect(parseTarget("https://localhost").port).toBe(443);
  });

  it("refuses a target with a path", () => {
    expect(() => parseTarget("http://localhost:3000/api")).toThrow(TargetError);
  });

  it("refuses a target with a query", () => {
    expect(() => parseTarget("http://localhost:3000/?a=1")).toThrow(TargetError);
  });

  it("refuses a target with a fragment", () => {
    expect(() => parseTarget("http://localhost:3000/#x")).toThrow(TargetError);
  });

  it("refuses a target with credentials", () => {
    expect(() => parseTarget("http://user:pass@localhost:3000")).toThrow(TargetError);
  });

  it("refuses a target without a scheme", () => {
    expect(() => parseTarget("localhost:3000")).toThrow(TargetError);
  });

  it("refuses a non-http scheme", () => {
    expect(() => parseTarget("ftp://localhost:3000")).toThrow(TargetError);
    expect(() => parseTarget("file:///etc/passwd")).toThrow(TargetError);
  });

  it("refuses an empty target", () => {
    expect(() => parseTarget("   ")).toThrow(TargetError);
  });
});

describe("canonicalHost", () => {
  it("folds the three loopback spellings together, and only those", () => {
    expect(canonicalHost("localhost")).toBe("localhost");
    expect(canonicalHost("127.0.0.1")).toBe("localhost");
    expect(canonicalHost("::1")).toBe("localhost");
    expect(canonicalHost("[::1]")).toBe("localhost");
    // Closed table: another loopback address is not an alias.
    expect(canonicalHost("127.0.0.2")).toBe("127.0.0.2");
  });

  it("lowercases and drops a trailing dot", () => {
    expect(canonicalHost("LocalHost.")).toBe("localhost");
    expect(canonicalHost("Dev.Internal.")).toBe("dev.internal");
  });
});

describe("isAllowed", () => {
  it("accepts any path and query on the same origin", () => {
    expect(allowed("http://localhost:3000/api/chat")).toBe(true);
    expect(allowed("http://localhost:3000/v1/conversations?x=1")).toBe(true);
  });

  it("accepts the loopback aliases of the target", () => {
    expect(allowed("http://127.0.0.1:3000/api/chat")).toBe(true);
    expect(allowed("http://[::1]:3000/api/chat")).toBe(true);
    expect(allowed("http://localhost.:3000/api/chat")).toBe(true);
  });

  it("refuses another port", () => {
    expect(allowed("http://localhost:3001/api/chat")).toBe(false);
  });

  it("refuses another host", () => {
    expect(allowed("http://evil.example.com/api/chat")).toBe(false);
    expect(allowed("http://192.168.1.10:3000/api/chat")).toBe(false);
  });

  it("refuses another scheme on the same host and port", () => {
    expect(allowed("https://localhost:3000/api/chat")).toBe(false);
  });

  it("refuses a host that merely ends with the target host", () => {
    expect(allowed("http://notlocalhost:3000/")).toBe(false);
    expect(allowed("http://localhost.evil.com:3000/")).toBe(false);
  });

  it("refuses a userinfo trick pointing elsewhere", () => {
    // The authority here is evil.com, not localhost.
    expect(allowed("http://localhost:3000@evil.com/")).toBe(false);
  });

  it("compares the default port correctly", () => {
    const plain = parseTarget("http://localhost");
    expect(isAllowed(new URL("http://localhost/x"), plain)).toBe(true);
    expect(isAllowed(new URL("http://localhost:80/x"), plain)).toBe(true);
    expect(isAllowed(new URL("http://localhost:8080/x"), plain)).toBe(false);
  });

  it("does not resolve DNS to decide, so an alias is not equivalent", () => {
    // 127.0.0.2 resolves to the same machine but is not in the closed table.
    expect(allowed("http://127.0.0.2:3000/")).toBe(false);
  });
});
