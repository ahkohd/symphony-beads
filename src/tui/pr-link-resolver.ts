import { exec } from "../exec.ts";

export interface PrResolutionInput {
  issueId: string;
  status: string;
  explicitPrUrl: unknown;
  description: unknown;
  comments: unknown;
}

export async function resolvePrUrl(input: PrResolutionInput): Promise<string | null> {
  let prUrl: string | null = null;

  if (typeof input.explicitPrUrl === "string" && input.explicitPrUrl.trim()) {
    prUrl = input.explicitPrUrl;
  }

  if (!prUrl) {
    prUrl = extractPrUrl(typeof input.description === "string" ? input.description : null);
  }

  if (!prUrl) {
    prUrl = extractPrUrlFromComments(input.comments);
  }

  if (!prUrl) {
    const prNumber = extractPrNumberFromComments(input.comments);
    if (prNumber) {
      prUrl = await lookupPrUrlByNumber(prNumber);
    }
  }

  if (!prUrl && canOpenPr(input.status)) {
    prUrl = await lookupPrUrlViaGitHub(input.issueId);
  }

  return prUrl;
}

function canOpenPr(status: string): boolean {
  return status === "review" || status === "closed";
}

function extractPrUrl(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/i);
  return match ? match[0] : null;
}

function parsePrListUrl(raw: string): string | null {
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

function parsePrViewUrl(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { url?: unknown };
    return typeof parsed.url === "string" && parsed.url.trim() ? parsed.url : null;
  } catch {
    return null;
  }
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

function extractPrUrlFromComments(comments: unknown): string | null {
  if (!Array.isArray(comments)) return null;

  for (const raw of comments) {
    if (!raw || typeof raw !== "object") continue;

    const candidate = raw as {
      text?: unknown;
      body?: unknown;
      content?: unknown;
    };

    const texts = [candidate.text, candidate.body, candidate.content];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      const url = extractPrUrl(text);
      if (url) return url;
    }
  }

  return null;
}

function extractPrNumberFromComments(comments: unknown): number | null {
  if (!Array.isArray(comments)) return null;

  for (const raw of comments) {
    if (!raw || typeof raw !== "object") continue;

    const candidate = raw as {
      text?: unknown;
      body?: unknown;
      content?: unknown;
    };

    const texts = [candidate.text, candidate.body, candidate.content];
    for (const text of texts) {
      if (typeof text !== "string") continue;
      const number = extractPrNumber(text);
      if (number) return number;
    }
  }

  return null;
}

async function lookupPrUrlByNumber(prNumber: number): Promise<string | null> {
  const prView = await exec(["gh", "pr", "view", String(prNumber), "--json", "url"], {
    cwd: process.cwd(),
    timeout: 10000,
  });

  if (prView.code !== 0 || !prView.stdout.trim()) return null;
  return parsePrViewUrl(prView.stdout);
}

async function lookupPrUrlViaGitHub(issueId: string): Promise<string | null> {
  const byHead = await exec(
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
      timeout: 10000,
    },
  );

  if (byHead.code === 0 && byHead.stdout.trim()) {
    const url = parsePrListUrl(byHead.stdout);
    if (url) return url;
  }

  const byTitle = await exec(
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
      timeout: 10000,
    },
  );

  if (byTitle.code === 0 && byTitle.stdout.trim()) {
    return parsePrListUrl(byTitle.stdout);
  }

  return null;
}
