import { exec } from "../exec.ts";

const GH_TIMEOUT_MS = 10000;
const PR_URL_PATTERN = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;
const PR_NUMBER_PATTERNS = [
  /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i,
  /\bPR\b[^\n#]*#(\d+)/i,
  /\bPR\b[^\n]*\(#(\d+)\)/i,
] as const;

export interface PrResolutionInput {
  issueId: string;
  status: string;
  explicitPrUrl: unknown;
  description: unknown;
  comments: unknown;
}

export type PrResolutionSource =
  | "issue_pr_url"
  | "description"
  | "comments_url"
  | "comments_pr_number"
  | "github_head"
  | "github_title"
  | "none";

type FoundPrResolutionSource = Exclude<PrResolutionSource, "none">;

export type PrResolutionResult =
  | {
      url: string;
      source: FoundPrResolutionSource;
    }
  | {
      url: null;
      source: "none";
    };

export function canOpenPr(status: string): boolean {
  return status === "review" || status === "closed";
}

export async function resolvePrLink(input: PrResolutionInput): Promise<PrResolutionResult> {
  const explicitPrUrl = asNonEmptyString(input.explicitPrUrl);
  if (explicitPrUrl) {
    return found(explicitPrUrl, "issue_pr_url");
  }

  const descriptionText = asNonEmptyString(input.description);
  const descriptionPrUrl = extractPrUrl(descriptionText);
  if (descriptionPrUrl) {
    return found(descriptionPrUrl, "description");
  }

  const commentPrUrl = extractPrUrlFromComments(input.comments);
  if (commentPrUrl) {
    return found(commentPrUrl, "comments_url");
  }

  const commentPrNumber = extractPrNumberFromComments(input.comments);
  if (commentPrNumber !== null) {
    const byNumber = await lookupPrUrlByNumber(commentPrNumber);
    if (byNumber) {
      return found(byNumber, "comments_pr_number");
    }
  }

  if (canOpenPr(input.status)) {
    const byHead = await lookupPrUrlByHead(input.issueId);
    if (byHead) {
      return found(byHead, "github_head");
    }

    const byTitle = await lookupPrUrlByTitle(input.issueId);
    if (byTitle) {
      return found(byTitle, "github_title");
    }
  }

  return {
    url: null,
    source: "none",
  };
}

function found(url: string, source: FoundPrResolutionSource): PrResolutionResult {
  return {
    url,
    source,
  };
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractPrUrl(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(PR_URL_PATTERN);
  return match ? match[0] : null;
}

function parsePrListUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;

      const url = (item as { url?: unknown }).url;
      const parsedUrl = asNonEmptyString(url);
      if (parsedUrl) {
        return parsedUrl;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function parsePrViewUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      url?: unknown;
    };

    return asNonEmptyString(parsed.url);
  } catch {
    return null;
  }
}

function extractPrNumber(text: string): number | null {
  for (const pattern of PR_NUMBER_PATTERNS) {
    const match = text.match(pattern);
    if (!match) continue;

    const value = Number.parseInt(match[1] ?? "", 10);
    if (Number.isFinite(value) && value > 0) {
      return value;
    }
  }

  return null;
}

function extractCommentTexts(comments: unknown): string[] {
  if (!Array.isArray(comments)) return [];

  const texts: string[] = [];
  for (const raw of comments) {
    if (!raw || typeof raw !== "object") continue;

    const candidate = raw as {
      text?: unknown;
      body?: unknown;
      content?: unknown;
    };

    for (const text of [candidate.text, candidate.body, candidate.content]) {
      const normalized = asNonEmptyString(text);
      if (normalized) {
        texts.push(normalized);
      }
    }
  }

  return texts;
}

function extractPrUrlFromComments(comments: unknown): string | null {
  for (const text of extractCommentTexts(comments)) {
    const url = extractPrUrl(text);
    if (url) {
      return url;
    }
  }

  return null;
}

function extractPrNumberFromComments(comments: unknown): number | null {
  for (const text of extractCommentTexts(comments)) {
    const number = extractPrNumber(text);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

async function lookupPrUrlByNumber(prNumber: number): Promise<string | null> {
  const result = await exec(["gh", "pr", "view", String(prNumber), "--json", "url"], {
    cwd: process.cwd(),
    timeout: GH_TIMEOUT_MS,
  });

  if (result.code !== 0 || !result.stdout.trim()) return null;
  return parsePrViewUrl(result.stdout);
}

async function lookupPrUrlByHead(issueId: string): Promise<string | null> {
  const result = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--head",
      `issue/${issueId}`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: GH_TIMEOUT_MS,
    },
  );

  if (result.code !== 0 || !result.stdout.trim()) return null;
  return parsePrListUrl(result.stdout);
}

async function lookupPrUrlByTitle(issueId: string): Promise<string | null> {
  const result = await exec(
    [
      "gh",
      "pr",
      "list",
      "--state",
      "all",
      "--search",
      `${issueId} in:title`,
      "--json",
      "url",
      "--limit",
      "1",
    ],
    {
      cwd: process.cwd(),
      timeout: GH_TIMEOUT_MS,
    },
  );

  if (result.code !== 0 || !result.stdout.trim()) return null;
  return parsePrListUrl(result.stdout);
}
