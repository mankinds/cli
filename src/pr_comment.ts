/**
 * Upsert a sticky scorecard comment on the current pull request.
 * Idempotent: looks up an existing comment by marker prefix and
 * patches it, otherwise creates a new one. Non-blocking: any
 * failure is logged by the caller but never breaks the gate.
 */

import * as github from "@actions/github";

import { STICKY_COMMENT_MARKER } from "./summary.js";

type Octokit = ReturnType<typeof github.getOctokit>;

export async function upsertStickyComment(octokit: Octokit, body: string): Promise<void> {
  const { context } = github;
  const pr = context.payload.pull_request;
  if (!pr) return;

  const { data: comments } = await octokit.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    per_page: 100,
  });

  const existing = comments.find((c) => c.body?.startsWith(STICKY_COMMENT_MARKER));

  if (existing) {
    await octokit.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  await octokit.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pr.number,
    body,
  });
}
