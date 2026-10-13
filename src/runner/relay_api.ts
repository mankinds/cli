/**
 * Client for the four runner routes of the public `/api/v1`.
 *
 *     POST   /api/v1/runners/sessions              pairing
 *     GET    /api/v1/runners/requests?wait=25      long poll
 *     POST   /api/v1/runners/requests/{id}/result  result
 *     DELETE /api/v1/runners/sessions/{id}         unregister
 *
 * The API key authenticates and scopes to an organization; it does not route.
 * Routing is by connection, and a connection admits a single live session.
 */

import { request } from "undici";

import { parseDetail, safeJson } from "../api.js";
import { MAX_POLL_WAIT_SECONDS, type RunnerRequestItem } from "./contract.js";

export const USER_AGENT = "mankinds-cli-runner";

/** Another runner holds this connection. Final: retrying in a loop is futile. */
export class RunnerBusyError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message);
  }
}

/** The session no longer holds the connection. The runner must pair again. */
export class SessionExpiredError extends Error {}

/** The connection is unknown, archived, or belongs to another organization. */
export class ConnectionNotFoundError extends Error {}

/** The connection is not configured for the local runner transport. */
export class TransportMismatchError extends Error {}

/** The API key was refused. */
export class AuthError extends Error {}

/** Anything else the API answered, or a transport failure. */
export class RelayApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null = null,
  ) {
    super(message);
  }
}

export interface RunnerSession {
  session_id: string;
  connection_id: string;
  expires_in_seconds: number;
  max_wait_seconds: number;
}

export class RunnerRelayClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(opts: { baseUrl: string; apiKey: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "User-Agent": USER_AGENT,
    };
    if (json) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Pair on a connection, exclusively.
   *
   * A 409 means another runner already holds it; that refusal stands for as
   * long as the holder keeps polling, so it is raised as
   * {@link RunnerBusyError} and never retried.
   */
  async openSession(connectionId: string, publicKey: string): Promise<RunnerSession> {
    const { statusCode, body } = await request(`${this.baseUrl}/api/v1/runners/sessions`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ connection_id: connectionId, public_key: publicKey }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await body.text();

    if (statusCode === 409) {
      const retryAfter = errorField(text, "retry_after_seconds");
      throw new RunnerBusyError(
        detailMessage(text) ??
          "Another runner already holds this connection.",
        typeof retryAfter === "number" ? retryAfter : null,
      );
    }
    if (statusCode === 400 && errorKey(text) === "connection_transport_not_local_runner") {
      throw new TransportMismatchError(
        detailMessage(text) ??
          "This connection does not use the local runner transport.",
      );
    }
    if (statusCode === 404) {
      throw new ConnectionNotFoundError(
        "No such connection for this API key. Check --connection, and that " +
          "the key belongs to the same organization.",
      );
    }
    if (statusCode === 401 || statusCode === 403) {
      throw new AuthError(`API key refused (HTTP ${statusCode}).`);
    }
    if (statusCode !== 200) {
      throw new RelayApiError(`pairing failed (HTTP ${statusCode}): ${parseDetail(text)}`, statusCode);
    }

    const json = safeJson(text);
    if (!json || typeof json.session_id !== "string") {
      throw new RelayApiError("pairing response missing 'session_id'");
    }
    return json as unknown as RunnerSession;
  }

  /**
   * Long poll for requests.
   *
   * Returns an empty array on a 204, which is what an elapsed wait, a worker
   * recycling and a relay hiccup all look like: the runner simply polls again.
   */
  async poll(
    connectionId: string,
    sessionId: string,
    waitSeconds: number,
  ): Promise<RunnerRequestItem[]> {
    const wait = Math.max(0, Math.min(waitSeconds, MAX_POLL_WAIT_SECONDS));
    const url =
      `${this.baseUrl}/api/v1/runners/requests` +
      `?connection_id=${encodeURIComponent(connectionId)}` +
      `&session_id=${encodeURIComponent(sessionId)}` +
      `&wait=${wait}`;

    const { statusCode, body } = await request(url, {
      method: "GET",
      headers: this.headers(false),
      // The server holds the call for up to `wait`; leave room on top of it
      // so our own timeout never fires before the server's does.
      signal: AbortSignal.timeout((wait + 15) * 1000),
      headersTimeout: (wait + 15) * 1000,
      bodyTimeout: (wait + 15) * 1000,
    });
    const text = await body.text();

    if (statusCode === 204) {
      return [];
    }
    if (statusCode === 404) {
      if (errorKey(text) === "runner_session_expired") {
        throw new SessionExpiredError(
          "This session no longer holds the connection.",
        );
      }
      throw new ConnectionNotFoundError("No such connection for this API key.");
    }
    if (statusCode === 401 || statusCode === 403) {
      throw new AuthError(`API key refused (HTTP ${statusCode}).`);
    }
    if (statusCode !== 200) {
      throw new RelayApiError(`poll failed (HTTP ${statusCode}): ${parseDetail(text)}`, statusCode);
    }

    const json = safeJson(text);
    const items = json?.requests;
    if (!Array.isArray(items)) {
      throw new RelayApiError("poll response missing 'requests'");
    }
    return items as RunnerRequestItem[];
  }

  /**
   * Report one sealed result. `false` means the relay already had one.
   *
   * Idempotent by design, so a submission the runner is unsure about can be
   * retried without risking a second delivery.
   */
  async submitResult(
    requestId: string,
    connectionId: string,
    sessionId: string,
    sealed: string,
  ): Promise<boolean> {
    const { statusCode, body } = await request(
      `${this.baseUrl}/api/v1/runners/requests/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({
          connection_id: connectionId,
          session_id: sessionId,
          result: sealed,
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    const text = await body.text();

    if (statusCode === 404 && errorKey(text) === "runner_session_expired") {
      throw new SessionExpiredError("This session no longer holds the connection.");
    }
    if (statusCode === 401 || statusCode === 403) {
      throw new AuthError(`API key refused (HTTP ${statusCode}).`);
    }
    if (statusCode !== 200) {
      throw new RelayApiError(`result failed (HTTP ${statusCode}): ${parseDetail(text)}`, statusCode);
    }
    return safeJson(text)?.accepted !== false;
  }

  /** Release the connection on a clean shutdown. Always best effort. */
  async closeSession(sessionId: string, connectionId: string): Promise<void> {
    const { body } = await request(
      `${this.baseUrl}/api/v1/runners/sessions/${encodeURIComponent(sessionId)}` +
        `?connection_id=${encodeURIComponent(connectionId)}`,
      {
        method: "DELETE",
        headers: this.headers(false),
        signal: AbortSignal.timeout(10_000),
      },
    );
    await body.dump().catch(() => undefined);
  }
}

/** `detail` is a plain string on some routes and an object on the runner ones. */
function detailObject(text: string): Record<string, unknown> | null {
  const json = safeJson(text);
  const detail = json?.detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    return detail as Record<string, unknown>;
  }
  return null;
}

function errorKey(text: string): string | null {
  const key = detailObject(text)?.error_key;
  return typeof key === "string" ? key : null;
}

function errorField(text: string, field: string): unknown {
  return detailObject(text)?.[field];
}

function detailMessage(text: string): string | null {
  const message = detailObject(text)?.message;
  return typeof message === "string" ? message : null;
}
