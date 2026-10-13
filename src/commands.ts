/**
 * Command dispatch for the published npm package, `npx @mankinds/cli <command>`.
 *
 * Separate from `main.ts`, which is the GitHub Action bundle. The two share
 * the API client and the exit codes and nothing else, on purpose:
 *
 * * `main.ts` is bundled by ncc into the committed `dist/`, 6.6 MB of it the
 *   Octokit stack behind `@actions/github`. Adding libsodium there would put
 *   1.7 MB the Action has no use for into a file that lives in git.
 * * This file loads every command lazily, so `npx @mankinds/cli dev` fetches
 *   and loads the sealing stack, and nothing else does.
 *
 * Neither entry point embeds an API key. It comes from the environment or a
 * flag, never from the package.
 *
 * The executable itself is `bin.ts`, which does nothing but call
 * {@link runBin}. Keeping the dispatch in a module with no side effect on
 * import is what lets the tests drive it directly.
 */

import { parseArgs } from "node:util";

import { EXIT_INFRA_ERROR, EXIT_OK } from "./exit_codes.js";

const DEFAULT_BASE_URL = "https://app.mankinds.io";

export async function runBin(argv: string[]): Promise<number> {
  const command = argv[0];

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return EXIT_OK;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    const { VERSION } = await import("./version.js");
    console.log(VERSION);
    return EXIT_OK;
  }

  const rest = argv.slice(1);
  switch (command) {
    case "dev":
      return dev(rest);
    case "doctor":
      return doctor(rest);
    case "ci": {
      // The CI runner, for anyone who reached it through npx rather than the
      // Action or the Docker image. No @actions dependency on this path.
      const { runCli } = await import("./cli.js");
      return runCli(rest);
    }
    default:
      console.error(`[mankinds] unknown command "${command}"`);
      printHelp();
      return EXIT_INFRA_ERROR;
  }
}

async function dev(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        connection: { type: "string" },
        target: { type: "string" },
        "api-key": { type: "string" },
        "base-url": { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`[mankinds] ${(error as Error).message}`);
    printDevHelp();
    return EXIT_INFRA_ERROR;
  }

  if (values.help) {
    printDevHelp();
    return EXIT_OK;
  }

  const apiKey = values["api-key"] ?? process.env.MANKINDS_API_KEY;
  if (!values.connection || !values.target || !apiKey) {
    console.error(
      "[mankinds] dev needs --connection, --target and an API key " +
        "(--api-key or MANKINDS_API_KEY).",
    );
    printDevHelp();
    return EXIT_INFRA_ERROR;
  }

  // Lazy: this is the import that pulls in libsodium.
  const { runDev } = await import("./runner/dev.js");
  return runDev({
    connectionId: values.connection,
    target: values.target,
    apiKey,
    baseUrl: values["base-url"] ?? process.env.MANKINDS_BASE_URL ?? DEFAULT_BASE_URL,
    verbose: values.verbose === true,
  });
}

async function doctor(argv: string[]): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        target: { type: "string" },
        path: { type: "string", default: "/" },
        method: { type: "string", default: "GET" },
        body: { type: "string" },
        verbose: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(`[mankinds] ${(error as Error).message}`);
    printDoctorHelp();
    return EXIT_INFRA_ERROR;
  }

  if (values.help) {
    printDoctorHelp();
    return EXIT_OK;
  }
  if (!values.target) {
    console.error("[mankinds] doctor needs --target.");
    printDoctorHelp();
    return EXIT_INFRA_ERROR;
  }

  const { runDoctor } = await import("./runner/doctor.js");
  return runDoctor({
    target: values.target,
    path: values.path ?? "/",
    method: values.method ?? "GET",
    body: values.body ?? null,
    verbose: values.verbose === true,
  });
}

function printHelp(): void {
  console.log(`mankinds <command> [options]

Commands:
  dev       Serve a Mankinds connection from this machine.
  doctor    Test a local target, without going through Mankinds.
  ci        Trigger an agent run and block on its quality gate.

Run "mankinds <command> --help" for the options of a command.

Exit codes: 0 ok, 1 quality gate failed (ci), 2 infrastructure error,
3 another runner already holds the connection (dev).
`);
}

function printDevHelp(): void {
  console.log(`mankinds dev --connection <uuid> --target <url> [options]

Serves a Mankinds connection from this machine. Mankinds renders each HTTP
request, this runner replays it against --target and seals the response back.
Nothing is exposed on the network: the connection to Mankinds is outbound.

  --connection <uuid>   Connection to serve, from its page in Mankinds.
  --target <url>        Local origin, scheme and host and port only, with no
                        path, for example http://localhost:3000. Any URL
                        outside it, a redirect included, is refused.
  --api-key <key>       Defaults to MANKINDS_API_KEY.
  --base-url <url>      Defaults to MANKINDS_BASE_URL or ${DEFAULT_BASE_URL}.
  --verbose             More detail about the session. Never the request
                        headers or body, which hold the credentials.
`);
}

function printDoctorHelp(): void {
  console.log(`mankinds doctor --target <url> [options]

Calls the target from this machine, through the same guard "dev" uses, and
says what happened. Mankinds is not involved and no API key is needed.

  --target <url>        Local origin to test, for example http://localhost:3000.
  --path <path>         Path to call. Defaults to /.
  --method <verb>       HTTP method. Defaults to GET.
  --body <json>         Request body. Sent as application/json.
  --verbose             More detail.
`);
}
