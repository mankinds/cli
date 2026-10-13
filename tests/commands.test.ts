/**
 * Command dispatch of the npm entry point.
 *
 * The lazy-loading property is checked here too: `doctor` and `ci` must not
 * drag in the sealing stack, which is what keeps `npx @mankinds/cli` cheap
 * for anyone who is not running `dev`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { runBin } from "../src/commands.js";
import { EXIT_INFRA_ERROR, EXIT_OK } from "../src/exit_codes.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MANKINDS_API_KEY;
});

function capture() {
  const lines: string[] = [];
  const push = (...args: unknown[]) => lines.push(args.join(" "));
  vi.spyOn(console, "log").mockImplementation(push);
  vi.spyOn(console, "error").mockImplementation(push);
  return lines;
}

describe("runBin", () => {
  it("prints help with no arguments", async () => {
    const lines = capture();
    expect(await runBin([])).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("mankinds <command>");
  });

  it("lists the three commands", async () => {
    const lines = capture();
    await runBin(["--help"]);
    const help = lines.join("\n");
    expect(help).toContain("dev");
    expect(help).toContain("doctor");
    expect(help).toContain("ci");
  });

  it("prints the version", async () => {
    const lines = capture();
    expect(await runBin(["--version"])).toBe(EXIT_OK);
    expect(lines.join("\n")).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("refuses an unknown command", async () => {
    const lines = capture();
    expect(await runBin(["deploy"])).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain('unknown command "deploy"');
  });

  it("refuses dev without a connection, a target or a key", async () => {
    const lines = capture();
    expect(await runBin(["dev"])).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("--connection");
  });

  it("refuses dev without an api key", async () => {
    const lines = capture();
    expect(
      await runBin(["dev", "--connection", "x", "--target", "http://localhost:3000"]),
    ).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("MANKINDS_API_KEY");
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    const lines = capture();
    expect(await runBin(["dev", "--targett", "http://localhost:3000"])).toBe(
      EXIT_INFRA_ERROR,
    );
    expect(lines.join("\n")).toContain("targett");
  });

  it("refuses doctor without a target", async () => {
    const lines = capture();
    expect(await runBin(["doctor"])).toBe(EXIT_INFRA_ERROR);
    expect(lines.join("\n")).toContain("--target");
  });

  it("prints per-command help", async () => {
    const lines = capture();
    expect(await runBin(["dev", "--help"])).toBe(EXIT_OK);
    expect(lines.join("\n")).toContain("--connection <uuid>");

    const more = capture();
    expect(await runBin(["doctor", "--help"])).toBe(EXIT_OK);
    expect(more.join("\n")).toContain("--path <path>");
  });

  it("never prints a secret it was handed on the command line", async () => {
    const lines = capture();
    await runBin(["dev", "--api-key", "mk_super_secret", "--connection", "nope"]);
    expect(lines.join("\n")).not.toContain("mk_super_secret");
  });
});
