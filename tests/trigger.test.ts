import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectTriggerMetadata, detectProvider } from "../src/trigger.js";

const CI_ENV_VARS = [
  "GITHUB_ACTIONS",
  "GITHUB_SHA",
  "GITHUB_REF_NAME",
  "GITHUB_REPOSITORY",
  "GITHUB_ACTOR",
  "GITHUB_RUN_ID",
  "GITHUB_EVENT_PATH",
  "GITLAB_CI",
  "CI_COMMIT_SHA",
  "CI_COMMIT_REF_NAME",
  "CI_PROJECT_PATH",
  "GITLAB_USER_LOGIN",
  "CI_MERGE_REQUEST_IID",
  "CI_PIPELINE_URL",
  "CIRCLECI",
  "CIRCLE_SHA1",
  "CIRCLE_BRANCH",
  "CIRCLE_PROJECT_REPONAME",
  "CIRCLE_USERNAME",
  "CIRCLE_PR_NUMBER",
  "CIRCLE_BUILD_URL",
  "BITBUCKET_BUILD_NUMBER",
  "BITBUCKET_COMMIT",
  "BITBUCKET_BRANCH",
  "BITBUCKET_REPO_FULL_NAME",
  "BITBUCKET_PR_ID",
  "JENKINS_HOME",
  "BUILD_URL",
  "GIT_COMMIT",
  "GIT_BRANCH",
  "JOB_NAME",
];

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of CI_ENV_VARS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CI_ENV_VARS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("detectProvider", () => {
  it("returns 'github_actions' when GITHUB_ACTIONS is set", () => {
    process.env.GITHUB_ACTIONS = "true";
    expect(detectProvider()).toBe("github_actions");
  });

  it("returns 'gitlab_ci' when GITLAB_CI is set", () => {
    process.env.GITLAB_CI = "true";
    expect(detectProvider()).toBe("gitlab_ci");
  });

  it("returns 'circleci' when CIRCLECI is set", () => {
    process.env.CIRCLECI = "true";
    expect(detectProvider()).toBe("circleci");
  });

  it("returns 'bitbucket_pipelines' when BITBUCKET_BUILD_NUMBER is set", () => {
    process.env.BITBUCKET_BUILD_NUMBER = "42";
    expect(detectProvider()).toBe("bitbucket_pipelines");
  });

  it("returns 'jenkins' when JENKINS_HOME is set", () => {
    process.env.JENKINS_HOME = "/var/jenkins_home";
    expect(detectProvider()).toBe("jenkins");
  });

  it("returns 'jenkins' when BUILD_URL is set", () => {
    process.env.BUILD_URL = "https://jenkins.example.com/job/foo/1/";
    expect(detectProvider()).toBe("jenkins");
  });

  it("returns 'ci' as fallback when no provider env var is set", () => {
    expect(detectProvider()).toBe("ci");
  });
});

describe("collectTriggerMetadata", () => {
  it("collects GitHub Actions metadata including a constructed run_url", () => {
    process.env.GITHUB_SHA = "deadbeef";
    process.env.GITHUB_REF_NAME = "feature/login";
    process.env.GITHUB_REPOSITORY = "mankinds/cli";
    process.env.GITHUB_ACTOR = "octocat";
    process.env.GITHUB_RUN_ID = "12345";

    const meta = collectTriggerMetadata("github_actions");

    expect(meta).toMatchObject({
      ci_provider: "github_actions",
      commit_sha: "deadbeef",
      branch: "feature/login",
      repo: "mankinds/cli",
      actor: "octocat",
      run_url: "https://github.com/mankinds/cli/actions/runs/12345",
    });
  });

  it("maps GitLab CI env vars including CI_MERGE_REQUEST_IID as an integer", () => {
    process.env.CI_COMMIT_SHA = "cafebabe";
    process.env.CI_COMMIT_REF_NAME = "main";
    process.env.CI_PROJECT_PATH = "group/project";
    process.env.CI_MERGE_REQUEST_IID = "7";

    const meta = collectTriggerMetadata("gitlab_ci");

    expect(meta).toMatchObject({
      ci_provider: "gitlab_ci",
      commit_sha: "cafebabe",
      branch: "main",
      repo: "group/project",
      pr_number: 7,
    });
    expect(typeof meta.pr_number).toBe("number");
  });

  it("excludes empty, null, and undefined env vars from the output", () => {
    process.env.GITHUB_SHA = "deadbeef";
    process.env.GITHUB_REF_NAME = "";

    const meta = collectTriggerMetadata("github_actions");

    expect(meta).toHaveProperty("commit_sha", "deadbeef");
    expect(meta).not.toHaveProperty("branch");
    expect(meta).not.toHaveProperty("repo");
    expect(meta).not.toHaveProperty("actor");
    expect(meta).not.toHaveProperty("run_url");
  });

  it("does not construct run_url when only GITHUB_REPOSITORY is set", () => {
    process.env.GITHUB_REPOSITORY = "mankinds/cli";

    const meta = collectTriggerMetadata("github_actions");

    expect(meta).not.toHaveProperty("run_url");
    expect(meta).toHaveProperty("repo", "mankinds/cli");
  });

  it("returns only ci_provider for an unknown provider", () => {
    const meta = collectTriggerMetadata("unknown_provider");

    expect(meta).toEqual({ ci_provider: "unknown_provider" });
  });
});
