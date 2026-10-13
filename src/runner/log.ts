/**
 * Logging for the local runner, built so a credential cannot reach it.
 *
 * The runner opens the sealed request, so it holds the rendered headers and
 * body in clear: `Authorization` included, because handing them to the local
 * target is the whole point. That is inherent and accepted, they are the
 * customer's own credentials on the customer's own machine, but it makes this
 * the one place in the CLI where a leak is possible.
 *
 * The rule is therefore absolute: **never log the opened payload or its
 * headers, not even in verbose mode.** The only thing a request is ever
 * described by is {@link safeRequestLabel}, which keeps the method and the
 * path and drops everything that can carry a secret, the query string first
 * of all: a configured URL may well end in `?api_key=...`.
 */

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Only printed with --verbose. Subject to the same redaction rule. */
  debug(message: string): void;
}

export function createLogger(verbose: boolean): Logger {
  return {
    info: (message) => console.log(`[mankinds] ${message}`),
    warn: (message) => console.warn(`[mankinds] ${message}`),
    error: (message) => console.error(`[mankinds] ${message}`),
    debug: (message) => {
      if (verbose) {
        console.log(`[mankinds] ${message}`);
      }
    },
  };
}

/**
 * The only safe description of a relayed request: method and path.
 *
 * Drops the query string, the fragment and any userinfo. Keeps the path,
 * which is what makes a log readable at all, and the origin is already known
 * from `--target` so repeating it adds nothing.
 */
export function safeRequestLabel(method: string, rawUrl: string): string {
  const verb = method.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 10) || "?";
  let path = "?";
  try {
    const url = new URL(rawUrl);
    path = url.pathname || "/";
    if (url.search !== "") {
      // Say that parameters exist, never what they are.
      path += "?…";
    }
  } catch {
    path = "?";
  }
  return `${verb} ${path}`;
}

/**
 * A short, secret-free description of a failure.
 *
 * Node surfaces a stable `code` on network errors (`ECONNREFUSED`,
 * `ENOTFOUND`, ...), which is exactly the useful part. Free-form messages are
 * truncated and only used when there is no code, because a message built from
 * a URL can carry a query string.
 */
export function safeErrorDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") {
    return code;
  }
  if (error instanceof Error && error.name !== "" && error.name !== "Error") {
    return error.name;
  }
  return "unknown error";
}
