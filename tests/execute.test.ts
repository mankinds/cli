/**
 * The guarded local call, against a real HTTP server on loopback.
 *
 * The cases that matter: a URL outside --target, a redirect that changes
 * origin, more than six hops, a response that is too large. They run
 * against a real socket rather than a mocked dispatcher, because what is
 * being tested is the behaviour of the transport, not of a stub.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RelayRequest } from "../src/runner/contract.js";
import { executeRelayRequest, prepareHeaders } from "../src/runner/execute.js";
import { parseTarget, type TargetOrigin } from "../src/runner/target.js";

let server: Server;
let port: number;
let target: TargetOrigin;
/** Set by a test to drive the next response. */
let handler: (req: IncomingMessage, res: ServerResponse) => void;

/** Last request the server saw, so header handling can be asserted. */
let lastHeaders: Record<string, string | string[] | undefined> = {};
let lastBody = "";
let lastMethod = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    lastMethod = req.method ?? "";
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      lastBody = Buffer.concat(chunks).toString("utf8");
      handler(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  target = parseTarget(`http://127.0.0.1:${port}`);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeRequest(overrides: Partial<RelayRequest> = {}): RelayRequest {
  return {
    request_id: "11111111-1111-4111-8111-111111111111",
    method: "GET",
    url: `http://127.0.0.1:${port}/api/chat`,
    headers: {},
    body: null,
    timeout_ms: 5_000,
    max_response_bytes: 2 * 1024 * 1024,
    follow_redirects: true,
    ...overrides,
  };
}

describe("executeRelayRequest, nominal", () => {
  it("relays status, headers and body, with the body base64 encoded", async () => {
    handler = (_req, res) => {
      res.writeHead(201, { "content-type": "application/json", "x-custom": "yes" });
      res.end(JSON.stringify({ reply: "hello" }));
    };

    const result = await executeRelayRequest(makeRequest(), target);

    expect(result.error).toBeNull();
    expect(result.status_code).toBe(201);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["x-custom"]).toBe("yes");
    expect(JSON.parse(Buffer.from(result.content!, "base64").toString("utf8"))).toEqual({
      reply: "hello",
    });
    expect(result.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("carries a binary body through base64 without corrupting it", async () => {
    // Bytes that are not valid UTF-8. This is why the contract says base64.
    const binary = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x7f, 0xc3, 0x28]);
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(binary);
    };

    const result = await executeRelayRequest(makeRequest(), target);

    expect(Buffer.from(result.content!, "base64").equals(binary)).toBe(true);
  });

  it("forwards the body and the Authorization header to the target", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };

    await executeRelayRequest(
      makeRequest({
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      }),
      target,
    );

    expect(lastMethod).toBe("POST");
    expect(JSON.parse(lastBody)).toEqual({ messages: [{ role: "user", content: "hi" }] });
    // Passed through untouched: handing it to the local target is the point.
    expect(lastHeaders.authorization).toBe("Bearer secret-token");
  });

  it("sets Host from the URL it calls, not from the payload", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("ok");
    };

    await executeRelayRequest(
      makeRequest({ headers: { host: "attacker.example.com" } }),
      target,
    );

    expect(lastHeaders.host).toBe(`127.0.0.1:${port}`);
  });
});

describe("prepareHeaders", () => {
  const url = new URL("http://localhost:3000/api");

  it("strips hop-by-hop headers", () => {
    const prepared = prepareHeaders(
      {
        "Content-Length": "42",
        "Transfer-Encoding": "chunked",
        Connection: "keep-alive",
        Upgrade: "websocket",
        "Keep-Alive": "timeout=5",
        TE: "trailers",
        Trailer: "Expires",
        "Proxy-Authorization": "Basic x",
        "Proxy-Connection": "keep-alive",
      },
      url,
    );
    expect(Object.keys(prepared)).toEqual(["host"]);
  });

  it("keeps application headers, X-Forwarded-* included", () => {
    const prepared = prepareHeaders(
      {
        Authorization: "Bearer t",
        "X-Forwarded-For": "10.0.0.1",
        "X-Api-Key": "k",
        accept: "application/json",
      },
      url,
    );
    expect(prepared["Authorization"]).toBe("Bearer t");
    expect(prepared["X-Forwarded-For"]).toBe("10.0.0.1");
    expect(prepared["X-Api-Key"]).toBe("k");
    expect(prepared["accept"]).toBe("application/json");
  });

  it("overrides Host whatever its case in the payload", () => {
    expect(prepareHeaders({ HOST: "elsewhere" }, url)["host"]).toBe("localhost:3000");
  });
});

describe("executeRelayRequest, refusals", () => {
  it("refuses a URL outside --target", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end("should not be reached");
    };

    const result = await executeRelayRequest(
      makeRequest({ url: "http://example.com/api/chat" }),
      target,
    );

    expect(result.error).toBe("target_not_allowed");
    expect(result.status_code).toBeNull();
  });

  it("refuses a URL on the right host but the wrong port", async () => {
    const result = await executeRelayRequest(
      makeRequest({ url: `http://127.0.0.1:${port + 1}/api/chat` }),
      target,
    );
    expect(result.error).toBe("target_not_allowed");
  });

  it("refuses an unparseable URL", async () => {
    const result = await executeRelayRequest(makeRequest({ url: "not a url" }), target);
    expect(result.error).toBe("target_not_allowed");
  });

  it("refuses a redirect that changes origin, even to another private host", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "http://192.168.1.50:3000/stolen" });
      res.end();
    };

    const result = await executeRelayRequest(makeRequest(), target);

    expect(result.error).toBe("target_not_allowed");
    expect(result.error_detail).toContain("redirect");
  });

  it("refuses a redirect that only changes port", async () => {
    handler = (_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${port + 1}/elsewhere` });
      res.end();
    };

    const result = await executeRelayRequest(makeRequest(), target);
    expect(result.error).toBe("target_not_allowed");
  });

  it("follows same-origin redirects, up to five hops", async () => {
    let hop = 0;
    handler = (_req, res) => {
      hop += 1;
      if (hop <= 5) {
        res.writeHead(302, { location: `/hop/${hop}` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("arrived");
    };

    const result = await executeRelayRequest(makeRequest(), target);

    expect(result.error).toBeNull();
    expect(result.status_code).toBe(200);
    expect(Buffer.from(result.content!, "base64").toString()).toBe("arrived");
  });

  it("refuses more than five redirects", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "/again" });
      res.end();
    };

    const result = await executeRelayRequest(makeRequest(), target);

    expect(result.error).toBe("target_not_allowed");
    expect(result.error_detail).toContain("redirect limit");
  });

  it("does not follow a redirect when follow_redirects is false", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    };

    const result = await executeRelayRequest(
      makeRequest({ follow_redirects: false }),
      target,
    );

    expect(result.error).toBeNull();
    expect(result.status_code).toBe(302);
  });

  it("degrades a 303 to GET and drops the body, like the direct transport", async () => {
    let first = true;
    handler = (_req, res) => {
      if (first) {
        first = false;
        res.writeHead(303, { location: "/after" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("done");
    };

    const result = await executeRelayRequest(
      makeRequest({ method: "POST", body: '{"a":1}' }),
      target,
    );

    expect(result.status_code).toBe(200);
    expect(lastMethod).toBe("GET");
    expect(lastBody).toBe("");
  });

  it("refuses a response over max_response_bytes, by content-length", async () => {
    handler = (_req, res) => {
      const payload = Buffer.alloc(5_000, 0x41);
      res.writeHead(200, { "content-length": String(payload.length) });
      res.end(payload);
    };

    const result = await executeRelayRequest(
      makeRequest({ max_response_bytes: 1_000 }),
      target,
    );

    expect(result.error).toBe("response_too_large");
    expect(result.error_detail).toContain("content-length");
  });

  it("refuses a response over max_response_bytes while streaming", async () => {
    handler = (_req, res) => {
      // Chunked, so no content-length to catch it up front.
      res.writeHead(200, { "content-type": "text/plain" });
      for (let i = 0; i < 20; i += 1) {
        res.write(Buffer.alloc(1_000, 0x42));
      }
      res.end();
    };

    const result = await executeRelayRequest(
      makeRequest({ max_response_bytes: 2_000 }),
      target,
    );

    expect(result.error).toBe("response_too_large");
  });

  it("reports an unreachable target as target_refused", async () => {
    // Port 1 on loopback: nothing listens there.
    const closed = parseTarget("http://127.0.0.1:1");
    const result = await executeRelayRequest(
      makeRequest({ url: "http://127.0.0.1:1/api/chat" }),
      closed,
    );

    expect(result.error).toBe("target_refused");
  });

  it("reports a slow target as target_timeout", async () => {
    handler = (_req, res) => {
      // Never answers within the budget.
      setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 2_000).unref();
    };

    const result = await executeRelayRequest(makeRequest({ timeout_ms: 150 }), target);

    expect(result.error).toBe("target_timeout");
  });
});
