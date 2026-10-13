/**
 * `doctor` against a real local server. It must reach a working target and
 * name the failure precisely when it cannot, since its whole job is telling
 * a broken target apart from a broken relay.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { EXIT_INFRA_ERROR, EXIT_OK } from "../src/exit_codes.js";
import { runDoctor } from "../src/runner/doctor.js";

let server: Server;
let targetUrl: string;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let lastPath = "";
let lastMethod = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastPath = req.url ?? "";
    lastMethod = req.method ?? "";
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "warn").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

const base = { path: "/", method: "GET", body: null, verbose: false };

describe("runDoctor", () => {
  it("reports a reachable target", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };
    const lines = capture();

    expect(await runDoctor({ ...base, target: targetUrl })).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("HTTP 200");
    expect(lines.join("\n")).toContain("libsodium loaded");
  });

  it("calls the path and method it was given", async () => {
    handler = (_req, res) => {
      res.writeHead(200).end("{}");
    };
    capture();

    await runDoctor({
      ...base,
      target: targetUrl,
      path: "/api/chat",
      method: "post",
      body: '{"a":1}',
    });

    expect(lastPath).toBe("/api/chat");
    expect(lastMethod).toBe("POST");
  });

  it("refuses a target that is not an origin, before calling anything", async () => {
    const lines = capture();
    expect(await runDoctor({ ...base, target: `${targetUrl}/api` })).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("without a path");
  });

  it("names an unreachable target", async () => {
    const lines = capture();
    expect(await runDoctor({ ...base, target: "http://127.0.0.1:1" })).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("target_refused");
    expect(lines.join("\n")).toContain("Is the service running");
  });

  it("warns, but succeeds, when the target answers an error status", async () => {
    handler = (_req, res) => {
      res.writeHead(401).end("unauthorized");
    };
    const lines = capture();

    expect(await runDoctor({ ...base, target: targetUrl })).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("HTTP 401");
    // The relay would reach it, so the problem is the configuration.
    expect(lines.join("\n")).toContain("credentials");
  });

  it("refuses a redirect that leaves the target", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://example.com/" }).end();
    };
    const lines = capture();

    expect(await runDoctor({ ...base, target: targetUrl })).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("target_not_allowed");
  });
});
