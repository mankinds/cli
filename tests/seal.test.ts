/**
 * Sealing, round-tripped against itself. Interoperability with the PyNaCl
 * codec is verified separately, cross-language, by
 * `tests/interop/check_interop.mjs` and its Python half.
 */

import { describe, expect, it } from "vitest";

import { MAX_SEALED_BYTES, type RelayResult } from "../src/runner/contract.js";
import {
  generateKeyPair,
  loadSodium,
  openRequest,
  parseOpenedRequest,
  SealError,
  sealResult,
} from "../src/runner/seal.js";

const validPayload = {
  request_id: "11111111-1111-4111-8111-111111111111",
  method: "POST",
  url: "http://localhost:3000/api/chat",
  headers: { "content-type": "application/json", authorization: "Bearer x" },
  body: '{"messages":[]}',
  timeout_ms: 30_000,
  max_response_bytes: 2_097_152,
  follow_redirects: true,
  reply_public_key: "",
};

async function seal(payload: unknown, publicKeyB64: string): Promise<string> {
  const sodium = await loadSodium();
  return sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string(JSON.stringify(payload)),
      sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL),
    ),
    sodium.base64_variants.ORIGINAL,
  );
}

describe("keys", () => {
  it("produces a 32 byte keypair with a base64 public key", async () => {
    const keys = await generateKeyPair();
    expect(keys.privateKey).toHaveLength(32);
    expect(keys.publicKeyBytes).toHaveLength(32);
    // ORIGINAL variant: standard alphabet, padded. 32 bytes is 44 characters.
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("gives a different keypair every time", async () => {
    const [a, b] = await Promise.all([generateKeyPair(), generateKeyPair()]);
    expect(a.publicKey).not.toBe(b.publicKey);
  });
});

describe("openRequest", () => {
  it("opens a request sealed toward the session key", async () => {
    const keys = await generateKeyPair();
    const reply = await generateKeyPair();
    const sealed = await seal(
      { ...validPayload, reply_public_key: reply.publicKey },
      keys.publicKey,
    );

    const { request, replyPublicKey } = await openRequest(sealed, keys);

    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost:3000/api/chat");
    expect(request.headers.authorization).toBe("Bearer x");
    expect(request.body).toBe('{"messages":[]}');
    expect(replyPublicKey).toBe(reply.publicKey);
  });

  it("refuses a box sealed toward another key", async () => {
    const keys = await generateKeyPair();
    const other = await generateKeyPair();
    const sealed = await seal(
      { ...validPayload, reply_public_key: other.publicKey },
      other.publicKey,
    );

    await expect(openRequest(sealed, keys)).rejects.toThrow(SealError);
  });

  it("refuses a payload that is not base64", async () => {
    const keys = await generateKeyPair();
    await expect(openRequest("!!!not base64!!!", keys)).rejects.toThrow(SealError);
  });

  it("refuses a sealed payload over the ceiling", async () => {
    const keys = await generateKeyPair();
    await expect(openRequest("A".repeat(MAX_SEALED_BYTES + 1), keys)).rejects.toThrow(
      /max is/,
    );
  });
});

describe("parseOpenedRequest", () => {
  it("refuses a payload without reply_public_key", () => {
    const rest: Record<string, unknown> = { ...validPayload };
    delete rest.reply_public_key;
    expect(() => parseOpenedRequest(rest)).toThrow(/reply_public_key/);
  });

  it("refuses a missing or mistyped field", () => {
    expect(() => parseOpenedRequest({ ...validPayload, reply_public_key: "k", url: 42 })).toThrow(
      /"url"/,
    );
    expect(() =>
      parseOpenedRequest({ ...validPayload, reply_public_key: "k", timeout_ms: 0 }),
    ).toThrow(/"timeout_ms"/);
    expect(() =>
      parseOpenedRequest({ ...validPayload, reply_public_key: "k", headers: { a: 1 } }),
    ).toThrow(/header value/);
  });

  it("treats a missing body as no body, and defaults follow_redirects to false", () => {
    const parsed = parseOpenedRequest({
      ...validPayload,
      reply_public_key: "k",
      body: null,
      follow_redirects: undefined,
    });
    expect(parsed.request.body).toBeNull();
    expect(parsed.request.follow_redirects).toBe(false);
  });

  it("refuses something that is not an object", () => {
    expect(() => parseOpenedRequest("nope")).toThrow(SealError);
    expect(() => parseOpenedRequest([1, 2])).toThrow(SealError);
    expect(() => parseOpenedRequest(null)).toThrow(SealError);
  });
});

describe("sealResult", () => {
  const result: RelayResult = {
    request_id: "11111111-1111-4111-8111-111111111111",
    status_code: 200,
    headers: { "content-type": "application/json" },
    content: Buffer.from("hello").toString("base64"),
    latency_ms: 12,
    error: null,
    error_detail: null,
  };

  it("seals toward the reply key and nothing else can open it", async () => {
    const reply = await generateKeyPair();
    const stranger = await generateKeyPair();
    const sodium = await loadSodium();

    const sealed = await sealResult(result, reply.publicKey);
    expect(sealed).not.toBeNull();

    const opened = JSON.parse(
      sodium.to_string(
        sodium.crypto_box_seal_open(
          sodium.from_base64(sealed!, sodium.base64_variants.ORIGINAL),
          reply.publicKeyBytes,
          reply.privateKey,
        ),
      ),
    );
    expect(opened).toEqual(result);

    expect(() =>
      sodium.crypto_box_seal_open(
        sodium.from_base64(sealed!, sodium.base64_variants.ORIGINAL),
        stranger.publicKeyBytes,
        stranger.privateKey,
      ),
    ).toThrow();
  });

  it("refuses a malformed reply key rather than sealing toward nothing", async () => {
    await expect(sealResult(result, "not-base64!!")).rejects.toThrow(SealError);
    await expect(sealResult(result, Buffer.alloc(16).toString("base64"))).rejects.toThrow(
      /32 bytes/,
    );
  });

  it("returns null when the sealed form would exceed the relay ceiling", async () => {
    const reply = await generateKeyPair();
    const huge: RelayResult = {
      ...result,
      content: Buffer.alloc(MAX_SEALED_BYTES, 0x41).toString("base64"),
    };
    expect(await sealResult(huge, reply.publicKey)).toBeNull();
  });
});
