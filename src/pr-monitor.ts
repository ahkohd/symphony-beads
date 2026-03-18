// ---------------------------------------------------------------------------
// PR monitor — watches GitHub PRs for issues in review state and
// auto-transitions beads issues based on PR outcomes.
//
// Merged PR       → bd update -s closed
// Changes requested → bd update -s open  (triggers re-dispatch)
// ---------------------------------------------------------------------------

import { exec } from "./exec.ts";
import { log } from "./log.ts";
import type { ServiceConfig } from "./types.ts";

interface PrInfo {
  number: number;
  title: string;
  branch: string;
  state: string;         // OPEN, MERGED, CLOSED
  reviewDecision: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, ""
  issueId: string | null;
}

export class PrMonitor {
  private cwd: string;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** PR numbers that have been fully handled — skip on future ticks. */
  private processedPrs = new Set<number>();

  constructor(config: ServiceConfig, pollIntervalMs?: number) {
    this.cwd = config.tracker.project_path;
    this.interval = pollIntervalMs ?? config.polling.interval_ms;
  }

  start(): void {
    if (this.stopped) return;
    log.info("pr monitor started", { interval_ms: this.interval });

    // Run immediately, then on interval
    this.check();
    this.timer = setInterval(() => this.check(), this.interval);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async check(): Promise<void> {
    if (this.stopped) return;

    // Get open + merged PRs from branches matching issue/symphony-beads-*
    const prs = await this.listPrs();
    if (!prs) return;

    for (const pr of prs) {
      // If a PR transitions back to plain OPEN (rework case), clear its
      // processed flag so we can re-evaluate it on a future tick.
      if (pr.state === "OPEN" && pr.reviewDecision !== "CHANGES_REQUESTED") {
        this.processedPrs.delete(pr.number);
        continue;
      }

      // Skip PRs we have already handled.
      if (this.processedPrs.has(pr.number)) continue;

      if (!pr.issueId) {
        // No associated issue — nothing to do, mark as processed.
        this.processedPrs.add(pr.number);
        continue;
      }

      if (pr.state === "MERGED") {
        log.info("pr merged, closing issue", {
          pr: pr.number,
          issue_id: pr.issueId,
        });
        await this.updateIssue(pr.issueId, "closed");
        this.processedPrs.add(pr.number);
      } else if (pr.state === "OPEN" && pr.reviewDecision === "CHANGES_REQUESTED") {
        log.info("pr has changes requested, reopening issue", {
          pr: pr.number,
          issue_id: pr.issueId,
        });
        await this.updateIssue(pr.issueId, "open");
        this.processedPrs.add(pr.number);
      }
    }
  }

  private async listPrs(): Promise<PrInfo[] | null> {
    const result = await exec(
      [
        "gh", "pr", "list",
        "--state", "all",
        "--limit", "50",
        "--json", "number,title,headRefName,state,reviewDecision",
      ],
      { cwd: this.cwd },
    );

    if (result.code !== 0) {
      log.debug("gh pr list failed", { stderr: result.stderr.slice(0, 200) });
      return null;
    }

    try {
      const raw = JSON.parse(result.stdout) as GhPrRaw[];
      return raw
        .filter((pr) => pr.headRefName.startsWith("issue/"))
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          branch: pr.headRefName,
          state: pr.state,
          reviewDecision: pr.reviewDecision || "",
          issueId: extractIssueId(pr.headRefName),
        }));
    } catch {
      log.debug("failed to parse gh pr list output");
      return null;
    }
  }

  private async updateIssue(issueId: string, status: string): Promise<void> {
    const result = await exec(
      ["bd", "update", issueId, "-s", status],
      { cwd: this.cwd },
    );
    if (result.code !== 0) {
      log.warn("failed to update issue status", {
        issue_id: issueId,
        status,
        stderr: result.stderr.slice(0, 200),
      });
    }
  }
}

/** Extract issue ID from branch name like "issue/symphony-beads-p00" */
function extractIssueId(branch: string): string | null {
  const match = branch.match(/^issue\/(.+)$/);
  return match?.[1] ?? null;
}

interface GhPrRaw {
  number: number;
  title: string;
  headRefName: string;
  state: string;
  reviewDecision: string;
}
