# mankinds/cli

The [Mankinds](https://mankinds.io) command line tool. Two jobs:

- **Serve a system that runs on your machine.** `mankinds dev` lets Mankinds
  evaluate a system on `localhost` without exposing anything on the network.
- **Block a merge on a quality gate.** The CI runner, as a **GitHub Action**
  (`mankinds/cli@v1`) or a **Docker image** (`ghcr.io/mankinds/ci:v1`).

```bash
npx @mankinds/cli dev --connection <uuid> --target http://localhost:3000
```

Requires Node 22 or later.

## Local runner

A system running on a developer machine has no inbound address, and Mankinds
refuses to call private addresses anyway. The local runner closes both gaps:
it opens an **outbound** TLS connection to Mankinds, long polls for HTTP
requests Mankinds has already rendered, replays them against your local
target, and returns the response.

```bash
export MANKINDS_API_KEY=mk_...
npx @mankinds/cli dev --connection 3f2504e0-... --target http://localhost:3000
```

The connection UUID is shown on the connection's page in Mankinds.

| Option | Description |
|---|---|
| `--connection <uuid>` | The connection to serve. Required. |
| `--target <url>` | Local origin: scheme, host and port, no path. Required. |
| `--api-key <key>` | Defaults to `MANKINDS_API_KEY`. |
| `--base-url <url>` | Defaults to `MANKINDS_BASE_URL`, else `https://app.mankinds.io`. |
| `--verbose` | More detail about the session. Never request contents. |

### What the runner will and will not do

This process runs on your machine, holds an organization API key, and
executes URLs it receives from a server against your private network. What
constrains it:

- **One origin, and only one.** A request is executed only if its scheme,
  host and port match `--target` exactly. `localhost`, `127.0.0.1` and `::1`
  are treated as the same host, and nothing else is. No DNS lookup takes part
  in that comparison, so no name can resolve its way out of it.
- **Redirects are re-checked at every hop**, five at most. A redirect that
  leaves the origin is refused, even when it points at another private
  address.
- **Responses are capped** at the size Mankinds asked for, checked on
  `Content-Length` and again while reading.
- **No proxy, ever.** The runner uses its own HTTP agent and ignores proxy
  environment variables, so a request cannot be diverted.
- **Transport headers are rewritten.** `Host` comes from the URL actually
  being called, never from the payload, and hop-by-hop headers are dropped.
  Application headers pass through unchanged, `Authorization` included.
- **Nothing is written to disk**, and no key is embedded in the package.

### Credentials

Credentials stay configured in Mankinds and arrive inside each request so the
runner can hand them to your local system. They are **sealed end to end**: the
runner generates an X25519 keypair at startup and sends only the public half,
so Mankinds' own queue holds ciphertext in both directions, and each response
is sealed toward a key that exists only in the process waiting for it.

The runner therefore sees your credentials in clear, as it must to forward
them. It never logs them: request logs are the method and the path, with the
query string removed, in verbose mode too.

### Diagnosing

`doctor` calls your target through the same guard, without involving Mankinds
and without an API key:

```bash
npx @mankinds/cli doctor --target http://localhost:3000 --path /api/chat
```

If `doctor` reaches your system, `dev` will too.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Stopped cleanly. |
| 2 | Configuration or connectivity error. |
| 3 | Another runner already holds this connection. |

Only one runner at a time may serve a connection: that is what guarantees an
evaluation never routes to somebody else's machine. If you need two machines
on one system, create a second connection.

## CI quality gate

Trigger a Mankinds AI quality gate from your CI/CD pipeline and block a merge
when the AI system regresses.

## GitHub Actions

```yaml
name: Mankinds quality gate
on:
  push:
    branches: [preprod]
jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: mankinds/cli@v1
        with:
          agent: pr-quality-gate
          api-key: ${{ secrets.MANKINDS_API_KEY }}
```

## GitLab CI

```yaml
mankinds_eval:
  image: ghcr.io/mankinds/ci:v1
  script:
    - mankinds-ci --agent pr-quality-gate
  variables:
    MANKINDS_API_KEY: $MANKINDS_API_KEY
```

## CI inputs (GitHub Action)

| Input | Required | Default | Description |
|---|---|---|---|
| `agent` | yes |  | Name or UUID of the Mankinds agent to trigger. |
| `api-key` | yes |  | Mankinds API key (typically `secrets.MANKINDS_API_KEY`). |
| `base-url` | no | `https://app.mankinds.io` | Override for on-premise deployments. |
| `timeout-minutes` | no | `30` | Max wait for the eval. |
| `comment-on-pr` | no | `true` | Post a sticky scorecard comment on the PR. |

## CI outputs

| Output | Description |
|---|---|
| `run-id` | UUID of the Mankinds run created by this step. |
| `score` | Overall score (0 to 1) returned by the scorecard. |
| `gate-passed` | `"true"` when the quality gate passed, `"false"` otherwise. |

## CI exit codes

| Code | Meaning |
|---|---|
| 0 | Quality gate passed. |
| 1 | Quality gate failed (regression detected). |
| 2 | Infrastructure error (network, invalid key, agent without gate, ...). |

## Documentation

Full setup guide and quality gate configuration: [docs.mankinds.io/docs/ci/getting-started](https://docs.mankinds.io/docs/ci/getting-started).

## License

Apache-2.0
