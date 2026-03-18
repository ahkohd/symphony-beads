// ---------------------------------------------------------------------------
// Mustache-like template renderer (zero dependencies)
// ---------------------------------------------------------------------------

import type { Issue } from "./types.ts";

/**
 * Render a prompt template with issue data.
 * Supports {{ var }}, {{ obj.key }}, {{#section}}...{{/section}}, and
 * {{^section}}...{{/section}} (inverted).
 */
export function renderPrompt(template: string, issue: Issue, attempt: number | null): string {
  const view: Record<string, unknown> = {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? "",
      priority: issue.priority ?? "",
      state: issue.state,
      labels: issue.labels.join(", "),
      blocked_by: issue.blocked_by,
    },
    attempt: attempt ?? "",
  };

  return render(template, view);
}

function render(template: string, ctx: Record<string, unknown>): string {
  // Handle sections: {{#key}}...{{/key}} and {{^key}}...{{/key}}
  let result = template.replace(
    /\{\{([#^])(\s*[\w.]+\s*)\}\}([\s\S]*?)\{\{\/\2\}\}/g,
    (_match, type: string, key: string, body: string) => {
      const val = resolve(ctx, key.trim());
      const truthy = isTruthy(val);
      if (type === "#" && truthy) {
        if (Array.isArray(val)) {
          return val.map((item) => {
            const itemCtx = typeof item === "object" && item ? { ...ctx, ...item } : ctx;
            return render(body, itemCtx as Record<string, unknown>);
          }).join("");
        }
        return render(body, ctx);
      }
      if (type === "^" && !truthy) {
        return render(body, ctx);
      }
      return "";
    },
  );

  // Handle variables: {{ key }} or {{key}}
  result = result.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const val = resolve(ctx, key);
    if (val === null || val === undefined) return "";
    return String(val);
  });

  return result;
}

function resolve(ctx: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function isTruthy(val: unknown): boolean {
  if (val === null || val === undefined || val === false || val === "") return false;
  if (Array.isArray(val) && val.length === 0) return false;
  return true;
}