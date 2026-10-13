/**
 * The membership rule: does a URL the server sent belong to `--target`?
 *
 * This is the guardrail that replaces the server side network policy on this
 * transport. That policy refuses private addresses, which is exactly what the
 * runner exists to reach, so it is inverted here: private is fine, anything
 * outside the one origin the developer named is not.
 *
 * The rule:
 *
 *     allowed(url) :=
 *          scheme(url)                     == scheme(target)
 *       &  canonical_host(url)             == canonical_host(target)
 *       &  port(url, scheme_default)       == port(target, scheme_default)
 *
 *     canonical_host(h) := lowercase(h), trailing dot removed, then
 *                          "localhost" if h is in {localhost, 127.0.0.1, ::1}
 *
 * No DNS resolution enters the comparison. An equivalence computed by
 * resolving would reopen a rebinding angle, where a host resolves inside the
 * perimeter at check time and elsewhere at connect time. The hardcoded table
 * is closed to those three values; it exists only to avoid the false negative
 * nobody would understand on a first run, a connection configured on
 * `127.0.0.1` and a `--target` on `localhost`.
 */

/** A `--target`, reduced to the three things the rule compares. */
export interface TargetOrigin {
  /** "http" or "https", lowercase, without the colon. */
  scheme: string;
  /** Canonical host, as defined above. */
  host: string;
  /** Effective port, the scheme default filled in. */
  port: number;
  /** The origin as it is shown to the user, e.g. `http://localhost:3000`. */
  display: string;
}

export class TargetError extends Error {}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

/**
 * The closed equivalence table. Three values, hardcoded, no DNS.
 * IPv6 arrives bracketed from `URL.hostname`, hence the second spelling.
 */
const LOOPBACK_ALIASES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Lowercase, drop a trailing dot, unwrap IPv6 brackets, fold loopback. */
export function canonicalHost(hostname: string): string {
  let host = hostname.trim().toLowerCase();
  while (host.endsWith(".")) {
    host = host.slice(0, -1);
  }
  if (LOOPBACK_ALIASES.has(host)) {
    return "localhost";
  }
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  return host;
}

function effectivePort(url: URL): number {
  if (url.port !== "") {
    return Number(url.port);
  }
  const scheme = url.protocol.replace(/:$/, "");
  return DEFAULT_PORTS[scheme] ?? 0;
}

/**
 * Parse and vet the `--target` the developer passed.
 *
 * The CLI refuses to start on a target carrying a path, a query, a fragment
 * or credentials, or without a scheme. A target with a path would give a
 * false impression of partitioning, and a prefix rule on the path would break
 * `conversation_id` mode, where `create_url` and the message URL have
 * different paths.
 */
export function parseTarget(raw: string): TargetOrigin {
  const value = raw.trim();
  if (value === "") {
    throw new TargetError("--target is empty");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TargetError(
      `--target must be an absolute URL with a scheme, for example ` +
        `http://localhost:3000 (got "${value}")`,
    );
  }

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    throw new TargetError(
      `--target must use http or https, not "${scheme}:". ` +
        `A bare host:port such as "${value}" is read as a scheme; ` +
        `write http://${value} instead.`,
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new TargetError("--target must not carry credentials");
  }
  if (url.pathname !== "" && url.pathname !== "/") {
    throw new TargetError(
      `--target must be an origin, without a path (got "${url.pathname}"). ` +
        `Paths come from the connection configured in Mankinds.`,
    );
  }
  if (url.search !== "") {
    throw new TargetError("--target must not carry a query string");
  }
  if (url.hash !== "") {
    throw new TargetError("--target must not carry a fragment");
  }

  const host = canonicalHost(url.hostname);
  if (host === "") {
    throw new TargetError("--target has no host");
  }
  const port = effectivePort(url);

  return { scheme, host, port, display: `${scheme}://${url.host}` };
}

/**
 * Whether *url* belongs to *target*, by the rule above.
 *
 * Applied to the URL the server sent and, again, to every redirect hop. A hop
 * that changes origin is refused even when the new origin is itself private.
 */
export function isAllowed(url: URL, target: TargetOrigin): boolean {
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  return (
    scheme === target.scheme &&
    canonicalHost(url.hostname) === target.host &&
    effectivePort(url) === target.port
  );
}

/**
 * Parse a URL the server sent, or return null when it is not parseable.
 * Never throws: an unparseable URL is a refusal, not a crash.
 */
export function parseRelayUrl(raw: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
}
