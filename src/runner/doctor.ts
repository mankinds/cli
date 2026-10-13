/**
 * `mankinds doctor --target <url>`.
 *
 * Tests the target locally, without going through Mankinds. When `dev` says a
 * call failed, this answers the next question: is the problem the target, or
 * the relay? It calls the target through the very same guarded executor the
 * relay uses, so a success here means `dev` will reach it too.
 *
 * It sends one request, by default a GET on the target root. Nothing is
 * probed, guessed or retried: an evaluated system is somebody's running
 * service, and a diagnostic has no business poking at it.
 */

import { EXIT_INFRA_ERROR, EXIT_OK } from "../exit_codes.js";
import { executeRelayRequest } from "./execute.js";
import { createLogger, safeErrorDetail } from "./log.js";
import { loadSodium } from "./seal.js";
import { parseTarget, TargetError, type TargetOrigin } from "./target.js";

/** Default ceiling when none is imposed by a relayed request. */
const DOCTOR_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DOCTOR_TIMEOUT_MS = 15_000;

export interface DoctorOptions {
  target: string;
  path: string;
  method: string;
  body: string | null;
  verbose: boolean;
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const log = createLogger(options.verbose);

  let target: TargetOrigin;
  try {
    target = parseTarget(options.target);
  } catch (error) {
    if (error instanceof TargetError) {
      log.error(error.message);
      return EXIT_INFRA_ERROR;
    }
    throw error;
  }
  log.info(`Target accepted: ${target.display}`);
  log.debug(`canonical host "${target.host}", port ${target.port}`);

  // Sealing is loaded lazily by `dev`, so a broken install only shows up at
  // the worst moment. Surfacing it here is the point of a doctor.
  try {
    await loadSodium();
    log.info("Sealing available: libsodium loaded.");
  } catch (error) {
    log.error(`Sealing unavailable: ${safeErrorDetail(error)}`);
    log.error("Reinstall the package: npx @mankinds/cli doctor will not fix itself.");
    return EXIT_INFRA_ERROR;
  }

  const url = new URL(options.path || "/", `${target.display}/`);
  const method = options.method.toUpperCase();
  const headers: Record<string, string> = { accept: "*/*" };
  if (options.body !== null) {
    headers["content-type"] = "application/json";
  }

  log.info(`Calling ${method} ${url.pathname}…`);
  const result = await executeRelayRequest(
    {
      request_id: "00000000-0000-4000-8000-000000000000",
      method,
      url: url.toString(),
      headers,
      body: options.body,
      timeout_ms: DOCTOR_TIMEOUT_MS,
      max_response_bytes: DOCTOR_MAX_RESPONSE_BYTES,
      follow_redirects: true,
    },
    target,
  );

  if (result.error !== null) {
    log.error(`Failed: ${result.error}${result.error_detail ? ` (${result.error_detail})` : ""}`);
    log.error(explain(result.error, target));
    return EXIT_INFRA_ERROR;
  }

  const size = result.content === null ? 0 : Buffer.from(result.content, "base64").length;
  log.info(`Reached: HTTP ${result.status_code} in ${result.latency_ms}ms, ${size} bytes.`);
  const contentType = result.headers["content-type"];
  if (contentType !== undefined) {
    log.info(`Content-Type: ${contentType}`);
  }
  if (result.status_code !== null && result.status_code >= 400) {
    log.warn(
      "The target answered, so the relay will reach it. The status is the " +
        "target's own: check the path, the method and the credentials " +
        "configured on the Mankinds connection.",
    );
  }
  return EXIT_OK;
}

function explain(error: string, target: TargetOrigin): string {
  switch (error) {
    case "target_refused":
      return `Nothing answered on ${target.display}. Is the service running, on that port?`;
    case "target_timeout":
      return "The target accepted the connection but did not answer in time.";
    case "target_not_allowed":
      return `The URL left ${target.display}. A redirect to another origin is refused by design.`;
    case "response_too_large":
      return `The response went over ${DOCTOR_MAX_RESPONSE_BYTES} bytes.`;
    default:
      return "";
  }
}
