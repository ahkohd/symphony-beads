import { canOpenPr } from "./external-actions.ts";

const PR_URL_PATTERN = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i;
const PR_NUMBER_PATTERNS = [
  /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/i,
  /\bPR\b[^\n#]*#(\d+)/i,
  /\bPR\b[^\n]*\(#(\d+)\)/i,
] as const;

interface CommentLike {
  text?: unknown;
  body?: unknown;
  content?: unknown;
}

export interface ResolvePrUrlOptions {
  issue: Record<string, unknown>;
  issueId: string;
  status: string;
  lookupPrUrlByNumber: (prNumber: number) => Promise<string | null>;
  lookupPrUrlViaGitHub: (issueId: string) => Promise<string | null>;
}

export function extractPrUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(PR_URL_PATTERN);
  return match ? match[0] : null;
}

export function parsePrListUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;

    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const url = (item as { url?: unknown }).url;
      if (typeof url === "string" && url.trim()) {
        return url;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function parsePrViewUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url : null;
  } catch {
    return null;
  }
}

export function extractPrNumber(text: string | null | undefined): number | null {
  if (!text) return null;

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

function getCommentTexts(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];

  const candidate = raw as CommentLike;
  const texts = [candidate.text, candidate.body, candidate.content];

  return texts.filter((value): value is string => typeof value === "string");
}

export function extractPrUrlFromComments(comments: unknown): string | null {
  if (!Array.isArray(comments)) return null;

  for (const comment of comments) {
    const texts = getCommentTexts(comment);
    for (const text of texts) {
      const url = extractPrUrl(text);
      if (url) return url;
    }
  }

  return null;
}

export function extractPrNumberFromComments(comments: unknown): number | null {
  if (!Array.isArray(comments)) return null;

  for (const comment of comments) {
    const texts = getCommentTexts(comment);
    for (const text of texts) {
      const number = extractPrNumber(text);
      if (number) return number;
    }
  }

  return null;
}

export async function resolvePrUrlForIssue({
  issue,
  issueId,
  status,
  lookupPrUrlByNumber,
  lookupPrUrlViaGitHub,
}: ResolvePrUrlOptions): Promise<string | null> {
  const comments = issue.comments;

  let prUrl: string | null = null;
  if (typeof issue.pr_url === "string" && issue.pr_url.trim()) {
    prUrl = issue.pr_url;
  }

  if (!prUrl) {
    prUrl = extractPrUrl(typeof issue.description === "string" ? issue.description : null);
  }

  if (!prUrl) {
    prUrl = extractPrUrlFromComments(comments);
  }

  if (!prUrl) {
    const prNumber = extractPrNumberFromComments(comments);
    if (prNumber) {
      prUrl = await lookupPrUrlByNumber(prNumber);
    }
  }

  if (!prUrl && canOpenPr(status)) {
    const resolvedIssueId =
      typeof issue.id === "string" && issue.id.trim() ? issue.id.trim() : issueId;
    prUrl = await lookupPrUrlViaGitHub(resolvedIssueId);
  }

  return prUrl;
}
