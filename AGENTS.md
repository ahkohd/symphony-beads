# Guidelines

## Tool Use

- **Always prefer `edit` over `write`** when modifying existing files. The `edit` tool makes surgical changes by matching exact text. Only use `write` when creating new files or when the majority of the file needs to change.
- When fixing compile errors or bugs, use `edit` to change only the broken lines — do NOT rewrite the entire file.
- Read the file first with `read` to find the exact text to replace, then use `edit` with that exact text.

## Before Committing

Always run these checks before `git add` and `git commit`:

```bash
bun run fmt        # format
bun run lint       # lint (must pass with 0 errors)
bun run test       # tests (must pass)
```

Do not commit if any of these fail. Fix the issues first.

## Code Style

- TypeScript, 2 spaces, double quotes, semicolons
- No `any` types — use proper types or `unknown`
- No unused variables or imports
- Use `node:` protocol for Node.js built-ins (e.g., `import { join } from "node:path"`)
