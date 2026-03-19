#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

PROJECT_DIR="$TMP_DIR/project"
BIN_DIR="$TMP_DIR/bin"
HOME_DIR="$TMP_DIR/home"

mkdir -p "$PROJECT_DIR" "$BIN_DIR" "$HOME_DIR"

cat >"$BIN_DIR/bd" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "config" ] && [ "${2:-}" = "set" ]; then
  exit 0
fi

if [ "${1:-}" = "version" ]; then
  echo "bd 0.0.0"
  exit 0
fi

if [ "${1:-}" = "list" ] && [ "${2:-}" = "--json" ]; then
  echo '[]'
  exit 0
fi

if [ "${1:-}" = "list" ] && [ "${2:-}" = "--all" ] && [ "${3:-}" = "--json" ]; then
  echo '[]'
  exit 0
fi

if [ "${1:-}" = "dolt" ] && [ "${2:-}" = "status" ]; then
  echo "stopped"
  exit 1
fi

echo "unsupported bd args: $*" >&2
exit 1
EOF

cat >"$BIN_DIR/dolt" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "version" ]; then
  echo "dolt version 0.0.0"
  exit 0
fi

echo "unsupported dolt args: $*" >&2
exit 1
EOF

cat >"$BIN_DIR/pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

echo "pi 0.0.0"
EOF

cat >"$BIN_DIR/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "--version" ]; then
  echo "gh version 0.0.0"
  exit 0
fi

if [ "${1:-}" = "auth" ] && [ "${2:-}" = "status" ]; then
  echo "Logged in to github.com as smoke-user" >&2
  exit 0
fi

echo "unsupported gh args: $*" >&2
exit 1
EOF

chmod +x "$BIN_DIR/bd" "$BIN_DIR/dolt" "$BIN_DIR/pi" "$BIN_DIR/gh"

export HOME="$HOME_DIR"
export PATH="$BIN_DIR:$PATH"

cd "$PROJECT_DIR"

bun "$ROOT_DIR/src/cli.ts" init
bun "$ROOT_DIR/src/cli.ts" validate --json >"$TMP_DIR/validate.json"
bun "$ROOT_DIR/src/cli.ts" doctor --json >"$TMP_DIR/doctor.json"
bun "$ROOT_DIR/src/cli.ts" instances --json >"$TMP_DIR/instances.json"
bun "$ROOT_DIR/src/cli.ts" status --json >"$TMP_DIR/status.json"

bun -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (typeof p.valid !== "boolean") process.exit(1);' "$TMP_DIR/validate.json"
bun -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!Array.isArray(p.checks)) process.exit(1);' "$TMP_DIR/doctor.json"
bun -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!Array.isArray(p.instances)) process.exit(1);' "$TMP_DIR/instances.json"
bun -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (!Array.isArray(p.issues)) process.exit(1);' "$TMP_DIR/status.json"

echo "CLI smoke checks passed"
