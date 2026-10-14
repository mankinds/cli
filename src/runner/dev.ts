/**
 * `mankinds dev --connection <uuid> --target <url>`.
 *
 * Opens an outbound connection to Mankinds, long polls for requests the
 * backend has already rendered, replays them against the local target and
 * seals the result back. All session, streaming and extraction logic stays on
 * the Mankinds side: the runner knows nothing about the configuration, the
 * turns or `input_path`.
 *
 * Two loop properties are load-bearing:
 *
 * * **A poll stays in flight while a request runs.** The session is refreshed
 *   by polling and lapses after 60 s. A runner that stopped polling for the
 *   duration of a slow local call would expire its own session and see the
 *   call it was serving abort as `local_runner_offline`. Requests are
 *   therefore dispatched without being awaited, which is also what lets
 *   several run at once.
 * * **A broken poll is an ordinary event.** The API recycles its workers
 *   periodically, so a worker cycling cuts polls as a matter of course.
 *   Reconnect without noise.
 */

import { setTimeout as delay } from "node:timers/promises";

import { Agent } from "undici";

import { EXIT_INFRA_ERROR, EXIT_OK, EXIT_RUNNER_BUSY } from "../exit_codes.js";
import { MAX_POLL_WAIT_SECONDS, type RunnerRequestItem } from "./contract.js";
import { executeRelayRequest } from "./execute.js";
import { createLogger, safeErrorDetail, safeRequestLabel, type Logger } from "./log.js";
import {
  AuthError,
  ConnectionNotFoundError,
  RelayApiError,
  RunnerBusyError,
  RunnerRelayClient,
  SessionExpiredError,
  TransportMismatchError,
  type RunnerSession,
} from "./relay_api.js";
import { generateKeyPair, SealError, openRequest, sealResult, type RunnerKeyPair } from "./seal.js";
import { parseTarget, TargetError, type TargetOrigin } from "./target.js";

/** Backoff between failed polls. Short, because a cut poll is routine. */
const RECONNECT_DELAY_MS = 1_000;
/** Ceiling on that backoff, for an API that is actually down. */
const MAX_RECONNECT_DELAY_MS = 15_000;
/** How long a clean shutdown waits for requests still running. */
const DRAIN_TIMEOUT_MS = 5_000;
/** One retry on a lost result submission, which the relay makes idempotent. */
const SUBMIT_RETRY_DELAY_MS = 500;

export interface DevOptions {
  connectionId: string;
  target: string;
  apiKey: string;
  baseUrl: string;
  verbose: boolean;
  /** Test seam: stop the loop from the outside. */
  signal?: AbortSignal;
}

export async function runDev(options: DevOptions): Promise<number> {
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

  if (!isUuid(options.connectionId)) {
    log.error(
      `--connection must be the connection UUID shown on the Connection page ` +
        `(got "${options.connectionId}")`,
    );
    return EXIT_INFRA_ERROR;
  }

  const client = new RunnerRelayClient({
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
  });

  let keys: RunnerKeyPair;
  try {
    keys = await generateKeyPair();
  } catch (error) {
    log.error(`could not initialise sealing: ${safeErrorDetail(error)}`);
    return EXIT_INFRA_ERROR;
  }

  let session: RunnerSession;
  try {
    session = await client.openSession(options.connectionId, keys.publicKey);
  } catch (error) {
    return reportPairingFailure(error, log);
  }

  log.info(`Runner online for connection ${options.connectionId}`);
  log.info(`Relaying requests to ${target.display}`);
  log.info("Press Ctrl+C to stop.");
  log.debug(`session ${session.session_id}, poll wait ${pollWait(session)}s`);

  const stopping = new AbortController();
  const detach = attachSignals(stopping, options.signal, log);
  const inFlight = new Set<Promise<void>>();
  // One pool for the whole session, so a multi-turn conversation reuses its
  // connection to the local target instead of paying a handshake per turn.
  // It is also how the runner ignores the environment: an explicit dispatcher
  // means no ambient proxy can divert a request.
  const dispatcher = new Agent({ connections: 16, pipelining: 0, connect: { timeout: 10_000 } });
  let exitCode = EXIT_OK;
  let reconnectDelay = RECONNECT_DELAY_MS;

  try {
    while (!stopping.signal.aborted) {
      let items: RunnerRequestItem[];
      try {
        items = await client.poll(
          session.connection_id,
          session.session_id,
          pollWait(session),
        );
        reconnectDelay = RECONNECT_DELAY_MS;
      } catch (error) {
        if (stopping.signal.aborted) break;

        if (error instanceof SessionExpiredError) {
          // Our grip lapsed. Pair again; a 409 now means someone else took
          // the connection, which is terminal.
          log.warn("Session expired, pairing again.");
          try {
            session = await client.openSession(options.connectionId, keys.publicKey);
            log.info("Reconnected.");
            continue;
          } catch (repairError) {
            exitCode = reportPairingFailure(repairError, log);
            break;
          }
        }
        if (error instanceof AuthError || error instanceof ConnectionNotFoundError) {
          log.error(error.message);
          exitCode = EXIT_INFRA_ERROR;
          break;
        }

        // A cut poll is routine: a worker cycling ends one as a matter of
        // course. Reconnect quietly.
        log.debug(`poll interrupted (${describe(error)}), reconnecting`);
        await sleep(reconnectDelay, stopping.signal);
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        continue;
      }

      for (const item of items) {
        // Deliberately not awaited: the next poll must go out now, so the
        // session keeps being refreshed while this request runs.
        const task = handleRequest(item, { client, session, keys, target, log, dispatcher })
          .catch((error) => {
            log.warn(`request ${item.request_id} failed: ${describe(error)}`);
          })
          .finally(() => {
            inFlight.delete(task);
          });
        inFlight.add(task);
      }
    }
  } finally {
    detach();
    await drain(inFlight, log);
    await client.closeSession(session.session_id, session.connection_id).catch(() => {
      // Best effort: the session lapses on its own within a minute anyway.
    });
    await dispatcher.close().catch(() => undefined);
    log.info("Runner stopped.");
  }

  return exitCode;
}

interface HandlerContext {
  client: RunnerRelayClient;
  session: RunnerSession;
  keys: RunnerKeyPair;
  target: TargetOrigin;
  log: Logger;
  dispatcher: Agent;
}

/** Open one request, run it, seal the result back. */
async function handleRequest(
  item: RunnerRequestItem,
  ctx: HandlerContext,
): Promise<void> {
  const remaining = item.expires_at_ms - Date.now();
  if (remaining <= 0) {
    // Nobody is waiting on it any more; the backend drops these too.
    ctx.log.debug(`request ${item.request_id} arrived past its deadline, skipped`);
    return;
  }

  let opened;
  try {
    opened = await openRequest(item.sealed, ctx.keys);
  } catch (error) {
    if (error instanceof SealError) {
      // Not answerable: without the reply key there is nothing to seal
      // toward, so the caller will time out, which is the right outcome.
      ctx.log.warn(`request ${item.request_id} could not be opened: ${error.message}`);
      return;
    }
    throw error;
  }

  const { request, replyPublicKey } = opened;
  // Safe label only: method and path. Never the headers or the body.
  // Logged once, on completion, so concurrent requests stay readable.
  const label = safeRequestLabel(request.method, request.url);

  const budget = Math.min(request.timeout_ms, Math.max(remaining, 1));
  const result = await executeRelayRequest(
    { ...request, timeout_ms: budget },
    ctx.target,
    { dispatcher: ctx.dispatcher },
  );

  if (result.error !== null) {
    ctx.log.warn(`${label} → ${result.error}${result.error_detail ? `: ${result.error_detail}` : ""}`);
  } else {
    ctx.log.info(`${label} → ${result.status_code} in ${result.latency_ms}ms`);
  }

  let sealed = await sealResult(result, replyPublicKey);
  if (sealed === null) {
    // Too large to travel sealed. That is what `response_too_large` means,
    // so report it rather than letting the caller time out.
    ctx.log.warn(`${label} → response too large to relay`);
    sealed = await sealResult(
      {
        ...result,
        status_code: null,
        headers: {},
        content: null,
        error: "response_too_large",
        error_detail: "sealed payload over the relay ceiling",
      },
      replyPublicKey,
    );
  }
  if (sealed === null) {
    return;
  }

  await submitWithOneRetry(ctx, request.request_id, sealed);
}

/**
 * Submit a result, retrying once on a transport failure.
 *
 * Safe because the relay guards the result by request id: a second delivery
 * is recognised and ignored. Worth doing because the alternative is the
 * caller waiting out its whole deadline over one dropped connection.
 */
async function submitWithOneRetry(
  ctx: HandlerContext,
  requestId: string,
  sealed: string,
): Promise<void> {
  try {
    await ctx.client.submitResult(
      requestId,
      ctx.session.connection_id,
      ctx.session.session_id,
      sealed,
    );
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      // The session is gone, so this result has nowhere to land and the
      // caller has already been told the runner went offline.
      throw error;
    }
    ctx.log.debug(`result submission failed (${describe(error)}), retrying once`);
    await delay(SUBMIT_RETRY_DELAY_MS, undefined, { ref: false });
    await ctx.client.submitResult(
      requestId,
      ctx.session.connection_id,
      ctx.session.session_id,
      sealed,
    );
  }
}

function reportPairingFailure(error: unknown, log: Logger): number {
  if (error instanceof RunnerBusyError) {
    // Exclusivity is the mechanism guaranteeing an evaluation never routes to
    // another developer's machine, so this refusal is final for as long as
    // the holder keeps polling. Say so, and do not retry in a loop.
    log.error("Another runner already holds this connection.");
    log.error(
      "Only one runner at a time may serve a connection. Stop the other " +
        "runner, or use a second local connection for this machine.",
    );
    if (error.retryAfterSeconds !== null) {
      log.error(
        `If it is already gone, the connection frees itself in about ` +
          `${error.retryAfterSeconds}s.`,
      );
    }
    return EXIT_RUNNER_BUSY;
  }
  if (error instanceof TransportMismatchError) {
    log.error(error.message);
    log.error("Set the connection transport to local_runner in Mankinds first.");
    return EXIT_INFRA_ERROR;
  }
  if (
    error instanceof ConnectionNotFoundError ||
    error instanceof AuthError ||
    error instanceof RelayApiError
  ) {
    log.error(error.message);
    return EXIT_INFRA_ERROR;
  }
  log.error(`could not pair: ${describe(error)}`);
  return EXIT_INFRA_ERROR;
}

/** Wait for in-flight requests, bounded, so Ctrl+C always returns. */
async function drain(inFlight: Set<Promise<void>>, log: Logger): Promise<void> {
  if (inFlight.size === 0) return;
  log.info(`Waiting for ${inFlight.size} request(s) in flight…`);
  await Promise.race([
    Promise.allSettled([...inFlight]),
    // Unreferenced, so the losing timer does not keep the process alive for
    // its full duration after the requests have finished.
    delay(DRAIN_TIMEOUT_MS, undefined, { ref: false }),
  ]);
}

function attachSignals(
  stopping: AbortController,
  external: AbortSignal | undefined,
  log: Logger,
): () => void {
  const stop = () => {
    if (!stopping.signal.aborted) {
      log.info("Stopping…");
      stopping.abort();
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  external?.addEventListener("abort", stop, { once: true });
  // Pairing happens before this point, so a caller that aborted during it has
  // already fired its event and `addEventListener` would never see it. Without
  // this the loop would run on with nobody able to stop it.
  if (external?.aborted === true) {
    stop();
  }
  return () => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    external?.removeEventListener("abort", stop);
  };
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // Aborted while waiting: the loop condition handles it.
  }
}

/** The poll wait, clamped to what the server publishes it will honour. */
function pollWait(session: RunnerSession): number {
  const advertised = session.max_wait_seconds;
  const wait = Number.isFinite(advertised) && advertised > 0 ? advertised : MAX_POLL_WAIT_SECONDS;
  return Math.min(wait, MAX_POLL_WAIT_SECONDS);
}

/** A message safe to print: API errors carry no customer payload. */
function describe(error: unknown): string {
  if (error instanceof RelayApiError || error instanceof SealError) {
    return error.message;
  }
  return safeErrorDetail(error);
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value.trim());
}
