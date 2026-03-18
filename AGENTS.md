# Guidelines

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
