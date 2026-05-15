# mankinds/cli

Trigger a [Mankinds](https://mankinds.io) AI quality gate from your CI/CD pipeline and block a merge when the AI system regresses.

Works natively as a **GitHub Action** (`mankinds/cli@v1`) and as a **Docker image** (`ghcr.io/mankinds/ci:v1`) for every other CI provider.

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

## Inputs (GitHub Action)

| Input | Required | Default | Description |
|---|---|---|---|
| `agent` | yes |  | Name or UUID of the Mankinds agent to trigger. |
| `api-key` | yes |  | Mankinds API key (typically `secrets.MANKINDS_API_KEY`). |
| `base-url` | no | `https://app.mankinds.io` | Override for on-premise deployments. |
| `timeout-minutes` | no | `30` | Max wait for the eval. |
| `comment-on-pr` | no | `true` | Post a sticky scorecard comment on the PR. |

## Outputs

| Output | Description |
|---|---|
| `run-id` | UUID of the Mankinds run created by this step. |
| `score` | Overall score (0 to 1) returned by the scorecard. |
| `gate-passed` | `"true"` when the quality gate passed, `"false"` otherwise. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Quality gate passed. |
| 1 | Quality gate failed (regression detected). |
| 2 | Infrastructure error (network, invalid key, agent without gate, ...). |

## Documentation

Full setup guide and quality gate configuration: [docs.mankinds.io/docs/ci/getting-started](https://docs.mankinds.io/docs/ci/getting-started).

## License

Apache-2.0
