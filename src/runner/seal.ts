/**
 * X25519 sealed boxes, the runner half of the relay codec.
 *
 * One primitive in both directions, libsodium's `crypto_box_seal`:
 *
 * * **Backend to runner.** The runner generates a keypair in memory at
 *   startup and sends only its public key at pairing. Every request is sealed
 *   toward that key, so the relay queue never holds a rendered request,
 *   credentials included, in clear.
 * * **Runner to backend.** Each request carries a `reply_public_key`, the
 *   public half of a keypair generated for that single request and held in
 *   the memory of the process waiting for the result. The runner seals its
 *   result toward it, so the customer system's response is not in clear
 *   either.
 *
 * Interop with PyNaCl is fixed by three choices, and all three must hold:
 * base64 in the ORIGINAL variant (padded, standard alphabet), public keys
 * carried as base64 text, private keys handled as 32 raw bytes.
 *
 * `libsodium-wrappers` is loaded lazily, from here and nowhere else. It
 * weighs about 1.7 MB that the GitHub Action, which is bundled and committed
 * under `dist/`, has no use for.
 */

import { createRequire } from "node:module";

import type { RelayRequest, RelayResult } from "./contract.js";
import { MAX_SEALED_BYTES } from "./contract.js";

type Sodium = typeof import("libsodium-wrappers");

let sodiumPromise: Promise<Sodium> | null = null;

/**
 * Load and initialise libsodium once per process.
 *
 * Loaded through `createRequire` rather than `await import(...)`, which is
 * not a style choice: `libsodium-wrappers@0.7.x` declares an `import`
 * condition pointing at `dist/modules-esm/libsodium-wrappers.mjs`, and that
 * file imports `./libsodium.mjs`, which ships in the sibling `libsodium`
 * package and so does not exist beside it. The ESM entry therefore fails to
 * resolve under plain Node. The CommonJS build has no such problem, and
 * requiring it keeps the load lazy all the same: the module is only pulled
 * in when `dev` first needs to seal something.
 */
export async function loadSodium(): Promise<Sodium> {
  if (sodiumPromise === null) {
    sodiumPromise = (async () => {
      const require = createRequire(import.meta.url);
      const mod = require("libsodium-wrappers") as { default?: Sodium } & Sodium;
      const sodium = (mod.default ?? mod) as Sodium;
      await sodium.ready;
      return sodium;
    })();
  }
  return sodiumPromise;
}

export class SealError extends Error {}

/** An X25519 keypair held in process memory, never written anywhere. */
export interface RunnerKeyPair {
  /** Base64 public key, the form carried on the wire. */
  publicKey: string;
  /** Raw 32-byte public key, needed to open a sealed box. */
  publicKeyBytes: Uint8Array;
  /** Raw 32-byte private key. Never leaves this process. */
  privateKey: Uint8Array;
}

export async function generateKeyPair(): Promise<RunnerKeyPair> {
  const sodium = await loadSodium();
  const pair = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
    publicKeyBytes: pair.publicKey,
    privateKey: pair.privateKey,
  };
}

/** What `open_request` returns: the request, plus the key to answer toward. */
export interface OpenedRequest {
  request: RelayRequest;
  replyPublicKey: string;
}

/**
 * Open one sealed request with the session keypair.
 *
 * The plaintext is a flat {@link RelayRequest} plus its
 * `reply_public_key`. Every field is validated here rather than trusted: this
 * is the only input the runner takes from the network, and a malformed one
 * must be a clean refusal, never a crash mid-loop.
 */
export async function openRequest(
  sealed: string,
  keys: RunnerKeyPair,
): Promise<OpenedRequest> {
  const sodium = await loadSodium();
  if (sealed.length > MAX_SEALED_BYTES) {
    throw new SealError(
      `sealed request is ${sealed.length} bytes, max is ${MAX_SEALED_BYTES}`,
    );
  }

  let plaintext: Uint8Array;
  try {
    const ciphertext = sodium.from_base64(sealed, sodium.base64_variants.ORIGINAL);
    plaintext = sodium.crypto_box_seal_open(
      ciphertext,
      keys.publicKeyBytes,
      keys.privateKey,
    );
  } catch {
    throw new SealError("sealed request could not be opened");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(sodium.to_string(plaintext));
  } catch {
    throw new SealError("sealed request is not valid JSON");
  }
  return parseOpenedRequest(payload);
}

/** Validate the decrypted object. Exported so tests can reach it directly. */
export function parseOpenedRequest(payload: unknown): OpenedRequest {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SealError("sealed request is not a JSON object");
  }
  const raw = payload as Record<string, unknown>;

  const replyPublicKey = raw.reply_public_key;
  if (typeof replyPublicKey !== "string" || replyPublicKey === "") {
    throw new SealError("sealed request carries no reply_public_key");
  }

  const headers: Record<string, string> = {};
  if (raw.headers !== undefined && raw.headers !== null) {
    if (typeof raw.headers !== "object" || Array.isArray(raw.headers)) {
      throw new SealError("sealed request has malformed headers");
    }
    for (const [name, value] of Object.entries(raw.headers as object)) {
      if (typeof value !== "string") {
        throw new SealError("sealed request has a non-string header value");
      }
      headers[name] = value;
    }
  }

  const request: RelayRequest = {
    request_id: requireString(raw, "request_id"),
    method: requireString(raw, "method"),
    url: requireString(raw, "url"),
    headers,
    body: raw.body === undefined || raw.body === null ? null : requireString(raw, "body"),
    timeout_ms: requirePositiveInt(raw, "timeout_ms"),
    max_response_bytes: requirePositiveInt(raw, "max_response_bytes"),
    follow_redirects: raw.follow_redirects === true,
  };
  return { request, replyPublicKey };
}

/**
 * Seal one result toward the per-request reply key.
 *
 * Returns `null` when the sealed form would exceed the relay's ceiling, which
 * the backend answers with a 413. The caller turns that into a
 * `response_too_large`, which is what it means: the response was too big to
 * come back.
 */
export async function sealResult(
  result: RelayResult,
  replyPublicKey: string,
): Promise<string | null> {
  const sodium = await loadSodium();

  let publicKey: Uint8Array;
  try {
    publicKey = sodium.from_base64(replyPublicKey, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new SealError("reply_public_key is not valid base64");
  }
  if (publicKey.length !== sodium.crypto_box_PUBLICKEYBYTES) {
    throw new SealError(
      `reply_public_key must be ${sodium.crypto_box_PUBLICKEYBYTES} bytes, ` +
        `got ${publicKey.length}`,
    );
  }

  const sealed = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(JSON.stringify(result)), publicKey),
    sodium.base64_variants.ORIGINAL,
  );
  return sealed.length > MAX_SEALED_BYTES ? null : sealed;
}

/** Base64 encode raw bytes in the variant the backend decodes with. */
export async function toBase64(raw: Uint8Array): Promise<string> {
  const sodium = await loadSodium();
  return sodium.to_base64(raw, sodium.base64_variants.ORIGINAL);
}

function requireString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string") {
    throw new SealError(`sealed request field "${field}" must be a string`);
  }
  return value;
}

function requirePositiveInt(raw: Record<string, unknown>, field: string): number {
  const value = raw[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new SealError(`sealed request field "${field}" must be a positive number`);
  }
  return Math.floor(value);
}
