/**
 * The dev loop, against a fake Mankinds API and a real local target.
 *
 * Both halves are real sockets: a stub relay serving the four runner routes
 * with the genuine sealing codec, and an ordinary HTTP server standing in for
 * the developer's system. What is under test is the loop's behaviour, so
 * mocking the transport away would test nothing.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_INFRA_ERROR, EXIT_OK, EXIT_RUNNER_BUSY } from "../src/exit_codes.js";
import type { RelayResult } from "../src/runner/contract.js";
import { isUuid, runDev } from "../src/runner/dev.js";
import { generateKeyPair, loadSodium } from "../src/runner/seal.js";

const CONNECTION_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const SESSION_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

/** A queued request the stub relay will hand to the runner. */
interface Queued {
  request_id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timeout_ms?: number;
  follow_redirects?: boolean;
}

class StubRelay {
  server!: Server;
  baseUrl = "";
  /** Requests waiting to be handed over. */
  queue: Queued[] = [];
  /** Results the runner submitted, opened. */
  results: RelayResult[] = [];
  /** Public key the runner paired with. */
  runnerPublicKey: string | null = null;
  /** How many polls have been served. */
  polls = 0;
  /** Polls currently blocked, i.e. in flight. */
  openPolls = 0;
  /** Highest number of polls ever in flight at once. */
  maxOpenPolls = 0;
  /** Answer the next pairing with a 409. */
  busy = false;
  /** Answer the next poll with an expired session. */
  expireNextPoll = false;
  /** Cut the next poll mid-flight, as a worker cycling would. */
  cutNextPoll = false;
  /** Drop the next result submission, as a dropped connection would. */
  dropNextResult = false;
  /** How many result submissions reached the server, dropped ones included. */
  resultAttempts = 0;
  /** Reply keys per request_id, so a result can be opened. */
  private replyKeys = new Map<string, { publicKey: string; privateKey: Uint8Array; publicKeyBytes: Uint8Array }>();
  private pollWaitMs = 200;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const body = await readBody(req);

    if (req.method === "POST" && url.pathname === "/api/v1/runners/sessions") {
      if (this.busy) {
        return json(res, 409, {
          detail: {
            error_key: "runner_connection_busy",
            message: "Another runner already holds this connection.",
            retry_after_seconds: 42,
          },
        });
      }
      this.runnerPublicKey = JSON.parse(body).public_key;
      return json(res, 200, {
        session_id: SESSION_ID,
        connection_id: CONNECTION_ID,
        expires_in_seconds: 60,
        max_wait_seconds: 25,
      });
    }

    if (req.method === "GET" && url.pathname === "/api/v1/runners/requests") {
      this.polls += 1;
      if (this.expireNextPoll) {
        this.expireNextPoll = false;
        return json(res, 404, {
          detail: { error_key: "runner_session_expired", message: "gone" },
        });
      }
      if (this.cutNextPoll) {
        this.cutNextPoll = false;
        // What a worker recycling looks like from here: the socket dies with
        // no response on it. It has to be the socket: `req.destroy()` once
        // the request stream has ended is a no-op, and the client would then
        // sit waiting for a response that never comes.
        req.socket.destroy();
        return;
      }

      this.openPolls += 1;
      this.maxOpenPolls = Math.max(this.maxOpenPolls, this.openPolls);
      try {
        const deadline = Date.now() + this.pollWaitMs;
        while (this.queue.length === 0 && Date.now() < deadline) {
          await delay(10);
        }
        if (this.queue.length === 0) {
          res.writeHead(204).end();
          return;
        }
        const taken = this.queue.splice(0, this.queue.length);
        const requests = await Promise.all(taken.map((item) => this.seal(item)));
        return json(res, 200, { requests });
      } finally {
        this.openPolls -= 1;
      }
    }

    const resultMatch = url.pathname.match(
      /^\/api\/v1\/runners\/requests\/([^/]+)\/result$/,
    );
    if (req.method === "POST" && resultMatch) {
      this.resultAttempts += 1;
      if (this.dropNextResult) {
        this.dropNextResult = false;
        req.socket.destroy();
        return;
      }
      const requestId = resultMatch[1]!;
      const keys = this.replyKeys.get(requestId);
      const sodium = await loadSodium();
      const opened = JSON.parse(
        sodium.to_string(
          sodium.crypto_box_seal_open(
            sodium.from_base64(JSON.parse(body).result, sodium.base64_variants.ORIGINAL),
            keys!.publicKeyBytes,
            keys!.privateKey,
          ),
        ),
      ) as RelayResult;
      this.results.push(opened);
      return json(res, 200, { accepted: true });
    }

    if (req.method === "DELETE") {
      res.writeHead(204).end();
      return;
    }

    json(res, 404, { detail: "not found" });
  }

  /** Seal one queued request toward the runner, as `dispatch` does. */
  private async seal(item: Queued) {
    const sodium = await loadSodium();
    const reply = await generateKeyPair();
    this.replyKeys.set(item.request_id, reply);
    const payload = {
      request_id: item.request_id,
      method: item.method,
      url: item.url,
      headers: item.headers,
      body: item.body,
      timeout_ms: item.timeout_ms ?? 5_000,
      max_response_bytes: 2_097_152,
      follow_redirects: item.follow_redirects ?? true,
      reply_public_key: reply.publicKey,
    };
    return {
      request_id: item.request_id,
      sealed: sodium.to_base64(
        sodium.crypto_box_seal(
          sodium.from_string(JSON.stringify(payload)),
          sodium.from_base64(this.runnerPublicKey!, sodium.base64_variants.ORIGINAL),
        ),
        sodium.base64_variants.ORIGINAL,
      ),
      expires_at_ms: Date.now() + 30_000,
    };
  }
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" }).end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

let relay: StubRelay;
let targetServer: Server;
let targetUrl: string;
let targetHandler: (req: IncomingMessage, res: ServerResponse) => void;
/** Every runner started by a test, so teardown can stop them all. */
let started: { stop: AbortController; done: Promise<number> }[] = [];

beforeEach(async () => {
  started = [];
  relay = new StubRelay();
  await relay.start();

  targetHandler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"reply":"ok"}');
  };
  targetServer = createServer((req, res) => {
    req.resume();
    req.on("end", () => targetHandler(req, res));
  });
  await new Promise<void>((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // A test that failed mid-flight leaves a runner polling, which would hold
  // the servers open and hang the hook. Stop them whatever happened.
  for (const runner of started) {
    runner.stop.abort();
    await runner.done.catch(() => undefined);
  }
  relay.server.closeAllConnections();
  targetServer.closeAllConnections();
  await relay.stop();
  await new Promise<void>((resolve) => targetServer.close(() => resolve()));
});

function start(overrides: Partial<Parameters<typeof runDev>[0]> = {}) {
  const stop = new AbortController();
  const done = runDev({
    connectionId: CONNECTION_ID,
    target: targetUrl,
    apiKey: "mk_test",
    baseUrl: relay.baseUrl,
    verbose: false,
    signal: stop.signal,
    ...overrides,
  });
  const runner = { stop, done };
  started.push(runner);
  return runner;
}

/** Wait until *predicate* holds, or fail the test by timing out. */
async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition never became true");
    await delay(10);
  }
}

describe("runDev, argument checks", () => {
  it("refuses a target that is not an origin", async () => {
    expect(await runDev({
      connectionId: CONNECTION_ID,
      target: "http://localhost:3000/api",
      apiKey: "mk_test",
      baseUrl: relay.baseUrl,
      verbose: false,
    })).toBe(EXIT_INFRA_ERROR);
  });

  it("refuses a connection id that is not a uuid", async () => {
    expect(await runDev({
      connectionId: "my-connection",
      target: targetUrl,
      apiKey: "mk_test",
      baseUrl: relay.baseUrl,
      verbose: false,
    })).toBe(EXIT_INFRA_ERROR);
  });

  it("recognises a uuid", () => {
    expect(isUuid(CONNECTION_ID)).toBe(true);
    expect(isUuid("3f2504e0")).toBe(false);
  });
});

describe("runDev, pairing", () => {
  it("exits on a 409 without looping", async () => {
    relay.busy = true;
    const { done } = start();
    expect(await done).toBe(EXIT_RUNNER_BUSY);
    // One pairing attempt, and no poll at all.
    expect(relay.polls).toBe(0);
  });

  it("sends a 32 byte public key at pairing", async () => {
    const { stop, done } = start();
    await until(() => relay.runnerPublicKey !== null);
    stop.abort();
    await done;
    expect(Buffer.from(relay.runnerPublicKey!, "base64")).toHaveLength(32);
  });

  it("stops when the caller aborted during pairing", async () => {
    // The signal fires before the loop attaches to it, so the listener alone
    // would never hear it and the runner would poll on forever. Aborting up
    // front is the deterministic form of that race.
    const stop = new AbortController();
    stop.abort();

    const done = runDev({
      connectionId: CONNECTION_ID,
      target: targetUrl,
      apiKey: "mk_test",
      baseUrl: relay.baseUrl,
      verbose: false,
      signal: stop.signal,
    });

    expect(await done).toBe(EXIT_OK);
  });
});

describe("runDev, relaying", () => {
  it("runs a queued request and reports the sealed result", async () => {
    const { stop, done } = start();
    await until(() => relay.polls > 0);

    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000001",
      method: "POST",
      url: `${targetUrl}/api/chat`,
      headers: { "content-type": "application/json", authorization: "Bearer secret" },
      body: '{"messages":[]}',
    });

    await until(() => relay.results.length === 1);
    stop.abort();
    expect(await done).toBe(EXIT_OK);

    const result = relay.results[0]!;
    expect(result.error).toBeNull();
    expect(result.status_code).toBe(200);
    expect(Buffer.from(result.content!, "base64").toString()).toBe('{"reply":"ok"}');
  });

  it("reports a refused url as target_not_allowed, without calling anything", async () => {
    let called = false;
    targetHandler = (_req, res) => {
      called = true;
      res.writeHead(200).end("{}");
    };

    const { stop, done } = start();
    await until(() => relay.polls > 0);
    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000002",
      method: "GET",
      url: "http://evil.example.com/api/chat",
      headers: {},
      body: null,
    });

    await until(() => relay.results.length === 1);
    stop.abort();
    await done;

    expect(relay.results[0]!.error).toBe("target_not_allowed");
    expect(called).toBe(false);
  });

  it("keeps a poll in flight while a slow request runs", async () => {
    // The load-bearing property: the session is refreshed by polling and
    // lapses after 60 s, so a runner that stopped polling during a long local
    // call would expire its own session and abort the very call it is serving.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    targetHandler = (_req, res) => {
      void held.then(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"reply":"slow"}');
      });
    };

    const { stop, done } = start();
    await until(() => relay.polls > 0);
    const pollsBefore = relay.polls;

    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000003",
      method: "GET",
      url: `${targetUrl}/slow`,
      headers: {},
      body: null,
      timeout_ms: 10_000,
    });

    // While the target holds the call, polling must carry on.
    await until(() => relay.polls > pollsBefore + 1);
    expect(relay.results).toHaveLength(0);

    release();
    await until(() => relay.results.length === 1);
    stop.abort();
    await done;

    expect(relay.results[0]!.status_code).toBe(200);
  });

  it("runs several requests at once", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    targetHandler = (req, res) => {
      seen.push(req.url ?? "");
      void held.then(() => res.writeHead(200).end("{}"));
    };

    const { stop, done } = start();
    await until(() => relay.polls > 0);
    for (let i = 0; i < 3; i += 1) {
      relay.queue.push({
        request_id: `aaaaaaaa-0000-4000-8000-00000000001${i}`,
        method: "GET",
        url: `${targetUrl}/concurrent/${i}`,
        headers: {},
        body: null,
        timeout_ms: 10_000,
      });
    }

    // All three reach the target before any of them completes.
    await until(() => seen.length === 3);
    release();
    await until(() => relay.results.length === 3);
    stop.abort();
    await done;
  });
});

describe("runDev, resilience", () => {
  it("reconnects silently after a cut poll", async () => {
    const { stop, done } = start();
    await until(() => relay.polls > 0);

    relay.cutNextPoll = true;
    const pollsBefore = relay.polls;
    await until(() => relay.polls > pollsBefore + 1, 10_000);

    // Still working afterwards.
    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000004",
      method: "GET",
      url: `${targetUrl}/after-cut`,
      headers: {},
      body: null,
    });
    await until(() => relay.results.length === 1, 10_000);
    stop.abort();
    expect(await done).toBe(EXIT_OK);
  });

  it("pairs again when the session expired", async () => {
    const { stop, done } = start();
    await until(() => relay.polls > 0);

    relay.runnerPublicKey = null;
    relay.expireNextPoll = true;

    // A fresh pairing happens, and the loop carries on.
    await until(() => relay.runnerPublicKey !== null, 10_000);
    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000005",
      method: "GET",
      url: `${targetUrl}/after-expiry`,
      headers: {},
      body: null,
    });
    await until(() => relay.results.length === 1, 10_000);
    stop.abort();
    expect(await done).toBe(EXIT_OK);
  });

  it("retries a result submission that was dropped", async () => {
    const { stop, done } = start();
    await until(() => relay.polls > 0);

    relay.dropNextResult = true;
    relay.queue.push({
      request_id: "aaaaaaaa-0000-4000-8000-000000000006",
      method: "GET",
      url: `${targetUrl}/retried`,
      headers: {},
      body: null,
    });

    // The first submission is dropped; the second one lands.
    await until(() => relay.results.length === 1, 10_000);
    expect(relay.resultAttempts).toBeGreaterThanOrEqual(2);
    expect(relay.results[0]!.status_code).toBe(200);

    stop.abort();
    expect(await done).toBe(EXIT_OK);
  });

  it("exits when the connection was taken over during a re-pairing", async () => {
    const { done } = start();
    await until(() => relay.polls > 0);
    relay.busy = true;
    relay.expireNextPoll = true;
    expect(await done).toBe(EXIT_RUNNER_BUSY);
  });
});
