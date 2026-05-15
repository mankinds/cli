/**
 * Detects the CI provider from well-known env vars and extracts
 * git provenance into the trigger_metadata payload persisted on
 * the run. The label is stored as trigger_source on the run so the
 * agent runs list can distinguish gitlab_ci from github_actions
 * from a generic ci without enlarging the backend enum.
 */

import * as fs from "node:fs";

export function detectProvider(): string {
  if (process.env.GITHUB_ACTIONS) return "github_actions";
  if (process.env.GITLAB_CI) return "gitlab_ci";
  if (process.env.CIRCLECI) return "circleci";
  if (process.env.BITBUCKET_BUILD_NUMBER) return "bitbucket_pipelines";
  if (process.env.JENKINS_HOME || process.env.BUILD_URL) return "jenkins";
  return "ci";
}

export function collectTriggerMetadata(provider: string): Record<string, unknown> {
  const meta: Record<string, unknown> = { ci_provider: provider };

  switch (provider) {
    case "github_actions":
      assignDefined(meta, {
        commit_sha: process.env.GITHUB_SHA,
        branch: process.env.GITHUB_REF_NAME,
        repo: process.env.GITHUB_REPOSITORY,
        actor: process.env.GITHUB_ACTOR,
        run_url:
          process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
            ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
            : undefined,
        pr_number: prNumberFromGithubEvent(),
      });
      break;
    case "gitlab_ci":
      assignDefined(meta, {
        commit_sha: process.env.CI_COMMIT_SHA,
        branch: process.env.CI_COMMIT_REF_NAME,
        repo: process.env.CI_PROJECT_PATH,
        actor: process.env.GITLAB_USER_LOGIN,
        pr_number: intOrUndefined(process.env.CI_MERGE_REQUEST_IID),
        run_url: process.env.CI_PIPELINE_URL,
      });
      break;
    case "circleci":
      assignDefined(meta, {
        commit_sha: process.env.CIRCLE_SHA1,
        branch: process.env.CIRCLE_BRANCH,
        repo: process.env.CIRCLE_PROJECT_REPONAME,
        actor: process.env.CIRCLE_USERNAME,
        pr_number: intOrUndefined(process.env.CIRCLE_PR_NUMBER),
        run_url: process.env.CIRCLE_BUILD_URL,
      });
      break;
    case "bitbucket_pipelines":
      assignDefined(meta, {
        commit_sha: process.env.BITBUCKET_COMMIT,
        branch: process.env.BITBUCKET_BRANCH,
        repo: process.env.BITBUCKET_REPO_FULL_NAME,
        pr_number: intOrUndefined(process.env.BITBUCKET_PR_ID),
      });
      break;
    case "jenkins":
      assignDefined(meta, {
        commit_sha: process.env.GIT_COMMIT,
        branch: process.env.GIT_BRANCH,
        repo: process.env.JOB_NAME,
        run_url: process.env.BUILD_URL,
      });
      break;
  }

  return meta;
}

function assignDefined(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && v !== null && v !== "") {
      target[k] = v;
    }
  }
}

function intOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

function prNumberFromGithubEvent(): number | undefined {
  try {
    const path = process.env.GITHUB_EVENT_PATH;
    if (!path) return undefined;
    const payload = JSON.parse(fs.readFileSync(path, "utf-8")) as {
      pull_request?: { number?: number };
    };
    return typeof payload.pull_request?.number === "number"
      ? payload.pull_request.number
      : undefined;
  } catch {
    return undefined;
  }
}
