/**
 * Run one rendered request against the local target, under guard.
 *
 * On this transport Mankinds makes no outbound call at all, so the server
 * side network policy protects nothing any more and its controls have to live
 * here instead, inverted. That policy is not a URL validator: it re-resolves
 * DNS at connect time, pins the connection to an approved numeric address,
 * blocks Unix sockets, forbids proxies and caps the response size as it
 * streams. The equivalents, for a runner whose whole purpose is to reach a
 * private address:
 *
 * | Server side control              | Runner equivalent                        |
 * | -------------------------------- | ---------------------------------------- |
 * | Refuse private addresses         | Refuse anything outside `--target`        |
 * | Re-resolve, pin to numeric IP    | Not needed: the rule is textual, never    |
 * |                                  | resolved, so no resolution can move it    |
 * | Block Unix sockets               | Scheme must equal the target's, so http   |
 * |                                  | or https; no `socketPath` is ever set     |
 * | Ignore the environment's proxy   | An explicit undici `Agent` per call, so   |
 * |                                  | no ambient dispatcher or proxy applies    |
 * | Cap the response                 | `content-length` check, then a byte       |
 * |                                  | counter while streaming                   |
 * | Six hops, same origin only       | Same, hop by hop                          |
 *
 * The one control that does *not* transpose is address pinning. The server
 * pins because the set of allowed addresses is "every public address", so a
 * name that resolves twice can move between two members of that set. Here the
 * allowed set is one origin, compared as text, and the name resolves on the
 * developer's own machine to whatever that developer's machine says. There is
 * nothing to pin it against.
 */

import { Agent, request as undiciRequest } from "undici";

import type { RelayErrorCode, RelayRequest, RelayResult } from "./contract.js";
import { safeErrorDetail } from "./log.js";
import { isAllowed, parseRelayUrl, type TargetOrigin } from "./target.js";

/**
 * Hop-by-hop headers, stripped before the request leaves. The runner owns the
 * transport, the server owns the application: everything else passes through
 * untouched, `Authorization` included, since that is the point.
 *
 * `X-Forwarded-*` is deliberately **not** stripped: those are application
 * headers and a customer may have configured them on purpose.
 */
const HOP_BY_HOP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  // `host` is not hop-by-hop, but it is rewritten rather than forwarded: the
  // runner sets it from the URL it actually calls, never from the payload.
  "host",
]);

/** Mirrors the direct transport: six attempts, so at most five redirects. */
const MAX_HOPS = 6;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ExecuteOptions {
  /** Overridable for tests; defaults to a fresh proxy-free undici Agent. */
  dispatcher?: Agent;
  /** Overridable for tests; defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Prepare the outgoing headers for one hop.
 *
 * Exported for tests: the stripping rule is a guardrail, not a detail.
 */
export function prepareHeaders(
  headers: Record<string, string>,
  url: URL,
): Record<string, string> {
  const prepared: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && !isProxyHeader(name)) {
      prepared[name] = value;
    }
  }
  // Always from the URL being called, never from the payload.
  prepared["host"] = url.host;
  return prepared;
}

function isProxyHeader(name: string): boolean {
  return name.toLowerCase().startsWith("proxy-");
}

/**
 * Replay one request against the local target and report what came back.
 *
 * Never throws: every outcome, refusal included, is a {@link RelayResult}.
 * The backend turns each `error` back into the exception the direct transport
 * would have raised, so a refusal here reads downstream exactly like a
 * blocked target there.
 */
export async function executeRelayRequest(
  relayRequest: RelayRequest,
  target: TargetOrigin,
  options: ExecuteOptions = {},
): Promise<RelayResult> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  // One deadline for the whole chain, redirects included. The backend applies
  // its timeout per hop; a single budget is strictly tighter, and it is what
  // the caller's own deadline actually allows.
  const deadline = started + relayRequest.timeout_ms;

  const ownsDispatcher = options.dispatcher === undefined;
  // An explicit dispatcher is how this transport ignores the environment: no
  // ambient global dispatcher, no environment proxy, no Unix socket.
  const dispatcher =
    options.dispatcher ??
    new Agent({ connections: 8, pipelining: 0, connect: { timeout: 10_000 } });

  let url = parseRelayUrl(relayRequest.url);
  if (url === null) {
    return failure(relayRequest, "target_not_allowed", "url is not parseable");
  }
  let method = relayRequest.method.toUpperCase();
  let body = relayRequest.body;

  try {
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      if (!isAllowed(url, target)) {
        return failure(
          relayRequest,
          "target_not_allowed",
          hop === 0
            ? `url is outside --target ${target.display}`
            : `redirect left --target ${target.display}`,
        );
      }

      const remaining = deadline - now();
      if (remaining <= 0) {
        return failure(relayRequest, "target_timeout", "deadline reached");
      }

      let response;
      try {
        response = await undiciRequest(url, {
          method: method as never,
          headers: prepareHeaders(relayRequest.headers, url),
          body: body !== null && hasBody(method) ? body : undefined,
          // The explicit Agent carries no redirect interceptor, so undici
          // hands back the 3xx rather than following it. Every hop is then
          // walked by hand below, through the membership rule.
          dispatcher,
          signal: AbortSignal.timeout(remaining),
          headersTimeout: remaining,
          bodyTimeout: remaining,
        });
      } catch (error) {
        return failure(relayRequest, classify(error, now() >= deadline), safeErrorDetail(error));
      }

      const location = firstHeader(response.headers, "location");
      const isRedirect = REDIRECT_STATUSES.has(response.statusCode) && location !== null;

      if (isRedirect && relayRequest.follow_redirects) {
        await discard(response.body);
        if (hop >= MAX_HOPS - 1) {
          return failure(relayRequest, "target_not_allowed", "redirect limit exceeded");
        }
        const next = parseRelayUrl(location, url.toString());
        if (next === null) {
          return failure(relayRequest, "target_not_allowed", "redirect url is not parseable");
        }
        // As the direct transport does: 301/302/303 degrade to GET and drop
        // the body.
        if (
          (response.statusCode === 301 ||
            response.statusCode === 302 ||
            response.statusCode === 303) &&
          method !== "HEAD"
        ) {
          method = "GET";
          body = null;
        }
        url = next;
        continue;
      }

      return await readBounded(relayRequest, response, started, now);
    }
    return failure(relayRequest, "target_not_allowed", "redirect limit exceeded");
  } finally {
    if (ownsDispatcher) {
      await dispatcher.close().catch(() => undefined);
    }
  }
}

type UndiciResponse = Awaited<ReturnType<typeof undiciRequest>>;

/** Read the body under the size cap, then build the result. */
async function readBounded(
  relayRequest: RelayRequest,
  response: UndiciResponse,
  started: number,
  now: () => number,
): Promise<RelayResult> {
  const limit = relayRequest.max_response_bytes;

  // Cheap refusal first, exactly like the backend's event hook: a declared
  // oversize body is refused before a single chunk is accumulated.
  const declared = firstHeader(response.headers, "content-length");
  if (declared !== null) {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed) && parsed > limit) {
      await discard(response.body);
      return failure(relayRequest, "response_too_large", `content-length ${parsed}`);
    }
  }

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        await discard(response.body);
        return failure(relayRequest, "response_too_large", `over ${limit} bytes`);
      }
      chunks.push(buffer);
    }
  } catch (error) {
    return failure(relayRequest, classify(error, false), safeErrorDetail(error));
  }

  return {
    request_id: relayRequest.request_id,
    status_code: response.statusCode,
    headers: flattenHeaders(response.headers),
    // Explicitly base64: a binary body would not survive as text.
    content: Buffer.concat(chunks).toString("base64"),
    latency_ms: Math.max(now() - started, 0),
    error: null,
    error_detail: null,
  };
}

function failure(
  relayRequest: RelayRequest,
  error: RelayErrorCode,
  detail: string,
): RelayResult {
  return {
    request_id: relayRequest.request_id,
    status_code: null,
    headers: {},
    content: null,
    latency_ms: null,
    error,
    error_detail: detail,
  };
}

/**
 * Map a thrown transport error onto the contract's vocabulary.
 *
 * Anything that is not clearly a timeout is reported as `target_refused`,
 * which the backend turns back into a connect error. Being wrong in that
 * direction is harmless; reporting a refusal as a timeout would make a
 * misconfigured target look like a slow one.
 */
function classify(error: unknown, pastDeadline: boolean): RelayErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  const name = error instanceof Error ? error.name : "";
  if (
    pastDeadline ||
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT"
  ) {
    return "target_timeout";
  }
  return "target_refused";
}

/**
 * Which methods carry a body, matching the relay exactly: it only ever fills
 * `body` for these three, so accepting it on others would mean sending
 * something the direct transport never would.
 */
function hasBody(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH";
}

type RawHeaders = Record<string, string | string[] | undefined>;

function firstHeader(headers: RawHeaders, name: string): string | null {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" ? value : null;
}

/**
 * Collapse undici's headers into the flat map the contract carries.
 *
 * Names are lowercased, matching what the backend does to the direct
 * transport's headers so both read alike. Repeated headers are joined, as a
 * flat map cannot hold them apart; the contract has no multi-value form, and
 * cookie handling is explicitly out of scope on this transport.
 */
function flattenHeaders(headers: RawHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

/** Drain and release a body we are not going to read. */
async function discard(body: UndiciResponse["body"]): Promise<void> {
  try {
    await body.dump();
  } catch {
    // Already destroyed, or the peer went away. Nothing to recover.
  }
}
