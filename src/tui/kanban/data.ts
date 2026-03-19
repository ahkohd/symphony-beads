import { exec } from "../../exec.ts";
import type { Issue } from "./types.ts";

export async function fetchAllIssues(): Promise<Issue[]> {
  try {
    const result = await exec(["bd", "list", "--all", "--json"], {
      cwd: process.cwd(),
      timeout: 10000,
    });

    if (result.code !== 0 || !result.stdout.trim()) return [];

    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((raw: Record<string, unknown>) => ({
      id: (raw.id as string) ?? "",
      title: (raw.title as string) ?? "(untitled)",
      status: (raw.status as string) ?? "open",
      priority: typeof raw.priority === "number" ? raw.priority : null,
      issue_type: (raw.issue_type as string) ?? "task",
      owner: (raw.owner as string) ?? null,
      created_at: typeof raw.created_at === "string" ? raw.created_at : null,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : null,
      closed_at: typeof raw.closed_at === "string" ? raw.closed_at : null,
    }));
  } catch {
    return [];
  }
}

export async function moveIssueStatus(issueId: string, newStatus: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "update", issueId, "--status", newStatus], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function closeIssue(issueId: string): Promise<boolean> {
  try {
    const result = await exec(["bd", "close", issueId, "--reason", "Closed from TUI"], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}
