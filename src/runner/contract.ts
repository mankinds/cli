/**
 * The wire contract of the local runner relay, mirrored from the Mankinds
 * side of it.
 *
 * Field names are the Python ones, verbatim, because these objects travel
 * as-is inside the sealed box. Anything renamed here would be silently
 * dropped by Pydantic on the other side.
 */

/** Why a local call failed. Mirrors `RelayErrorCode`. */
export type RelayErrorCode =
  /** The runner could not reach the local target. */
  | "target_refused"
  /** The local target did not answer within the runner's own budget. */
  | "target_timeout"
  /** The runner refused the URL: outside --target, or a blocked redirect. */
  | "target_not_allowed"
  /** The local response exceeded max_response_bytes. */
  | "response_too_large";

/**
 * A fully rendered HTTP request, ready to be replayed as-is.
 *
 * The runner knows nothing about connections, turns or `input_path`. It
 * replays this request against its own target and returns what came back.
 */
export interface RelayRequest {
  request_id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Serialized body. `null` means no body (GET, or an empty POST). */
  body: string | null;
  timeout_ms: number;
  max_response_bytes: number;
  follow_redirects: boolean;
}

/**
 * What the runner reports back for one {@link RelayRequest}.
 *
 * `content` is base64 on the wire, explicitly: the backend codec decodes it
 * with `base64.b64decode`, so a binary body survives the trip intact. Letting
 * it travel as text would corrupt anything that is not valid UTF-8.
 */
export interface RelayResult {
  request_id: string;
  status_code: number | null;
  headers: Record<string, string>;
  /** Raw response bytes, base64 (RFC 4648 original alphabet, padded). */
  content: string | null;
  latency_ms: number | null;
  error: RelayErrorCode | null;
  error_detail: string | null;
}

/** A sealed request as the long poll hands it over. */
export interface RunnerRequestItem {
  request_id: string;
  sealed: string;
  /** Absolute deadline, epoch milliseconds. Past it, nobody is waiting. */
  expires_at_ms: number;
}

/**
 * Ceiling on one sealed payload, measured on the base64 text. The relay
 * answers 413 above it, so the runner checks before submitting rather than
 * after being refused.
 */
export const MAX_SEALED_BYTES = 8 * 1024 * 1024;

/** The relay's session TTL: the grip lapses without a poll. */
export const SESSION_TTL_SECONDS = 60;

/** The relay's longest poll wait: anything above is clamped. */
export const MAX_POLL_WAIT_SECONDS = 25;
