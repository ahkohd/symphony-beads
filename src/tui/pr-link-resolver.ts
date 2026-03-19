import { exec } from "../exec.ts";

const GITHUB_LOOKUP_TIMEOUT_MS = 10000;

export type PrLinkResolutionSource =
  | "issue_field"
  | "description"
  | "comments_url"
  | "comments_pr_number"
  | "gh_head_branch"
  | "gh_title_search"
  | "not_found";

export const PR_LINK_RESOLUTION_PRECEDENCE: ReadonlyArray<
  Exclude<PrLinkResolutionSource, "not_found">
> = [
  "issue_field",
  "description",
  "comments_url",
  "comments_pr_number",
  "gh_head_branch",
  "gh_title_search",
];

export interface PrLinkResolutionInput {
  issueId: string;
  status: string;
  prUrl: string | null;
  description: string | null;
  comments: unknown;
}

export interface PrLinkResolutionResult {
  url: string | null;
  source: PrLinkResolutionSource;
  prNumber: number | null;
}

export function canUsePrActions(status: string): boolean {
  return status === "review" || status === "closed";
}

export async function resolvePrLink(input: PrLinkResolutionInput): Promise<PrLinkResolutionResult> {
  const issueFieldUrl = normalizeNonEmptyString(input.prUrl);
  if (issueFieldUrl) {
    return {
      url: issueFieldUrl,
      source: "issue_field",
      prNumber: null,
    };
  }

  const descriptionUrl = extractPrUrl(input.description);
  if (descriptionUrl) {
    return {
      url: descriptionUrl,
      source: "description",
      prNumber: null,
    };
  }

  const commentUrl = extractPrUrlFromComments(input.comments);
  if (commentUrl) {
    return {
      url: commentUrl,
      source: "comments_url",
      prNumber: null,
    };
  }

  const commentPrNumber = extractPrNumberFromComments(input.comments);
  if (commentPrNumber !== null) {
    const byNumber = await lookupPrUrlByNumber(commentPrNumber);
    if (byNumber) {
      return {
        url: byNumber,
        source: "comments_pr_number",
        prNumber: commentPrNumber,
      };
    }
  }

  if (canUsePrActions(input.status)) {
    const byHead = await lookupPrUrlByHeadBranch(input.issueId);
    if (byHead) {
      return {
        url: byHead,
        source: "gh_head_branch",
        prNumber: null,
      };
    }

    const byTitle = await lookupPrUrlByTitleSearch(input.issueId);
    if (byTitle) {
      return {
        url: byTitle,
        source: "gh_title_search",
        prNumber: null,
      };
    }
  }

  return {
    url: null,
    source: "not_found",
    prNumber: commentPrNumber,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function extractPrUrl(text: string | null | undefined): string | null {
  if (!text) return null;

  const match = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i);
  return normalizeNonEmptyString(match?.[0]);
}

function extractPrNumber(text: string | null | undefined): number | null {
  if (!text) return null;

  const patterns = [
    /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i,
    /\bPR\b[^\n#]*#(\d+)/i,
    /\bPR\b[^\n]*\(#(\d+)\)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

function collectCommentTexts(comments: unknown): string[] {
  if (!Array.isArray(comments)) return [];

  const texts: string[] = [];
  for (const comment of comments) {
    if (!isRecord(comment)) continue;

    const candidates = [comment.text, comment.body, comment.content];
    for (const candidate of candidates) {
      const text = normalizeNonEmptyString(candidate);
      if (text) {
        texts.push(text);
      }
    }
  }

  return texts;
}

function extractPrUrlFromComments(comments: unknown): string | null {
  const texts = collectCommentTexts(comments);
  for (const text of texts) {
    const url = extractPrUrl(text);
    if (url) {
      return url;
    }
  }

  return null;
}

function extractPrNumberFromComments(comments: unknown): number | null {
  const texts = collectCommentTexts(comments);
  for (const text of texts) {
    const prNumber = extractPrNumber(text);
    if (prNumber !== null) {
      return prNumber;
    }
  }

  return null;
}

function parsePrListUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;

    for (const item of parsed) {
      if (!isRecord(item)) continue;

      const url = normalizeNonEmptyString(item.url);
      if (url) {
        return url;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function parsePrViewUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;

    return normalizeNonEmptyString(parsed.url);
  } catch {
    return null;
  }
}

async function lookupPrUrlByNumber(prNumber: number): Promise<string | null> {
  const prView = await exec(["gh", "pr", "view", String(prNumber), "--json", "url"], {
    cwd: process.cwd(),
    timeout: GITHUB_LOOKUP_TIMEOUT_MS,
  });

  if (prView.code !== 0 || !prView.stdout.trim()) return null;
  return parsePrViewUrl(prView.stdout);
}

async function lookupPrUrlByHeadBranch(issueId: string): Promise<string | null> {
  const normalizedIssueId = issueId.trim();
  if (!normalizedIssueId) return null;

  const byHead = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      `issue/${normalizedIssueId}`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: GITHUB_LOOKUP_TIMEOUT_MS,
    },
  );

  if (byHead.code !== 0 || !byHead.stdout.trim()) return null;
  return parsePrListUrl(byHead.stdout);
}

async function lookupPrUrlByTitleSearch(issueId: string): Promise<string | null> {
  const normalizedIssueId = issueId.trim();
  if (!normalizedIssueId) return null;

  const byTitle = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--search",
      `${normalizedIssueId} in:title`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: GITHUB_LOOKUP_TIMEOUT_MS,
    },
  );

  if (byTitle.code !== 0 || !byTitle.stdout.trim()) return null;
  return parsePrListUrl(byTitle.stdout);
}
