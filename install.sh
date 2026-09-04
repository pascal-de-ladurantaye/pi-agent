#!/usr/bin/env bash
# Install this checkout as a Pi package and link its global append-system prompt.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
PROMPT_SOURCE="$SCRIPT_DIR/APPEND_SYSTEM.md"
PROMPT_TARGET="$AGENT_DIR/APPEND_SYSTEM.md"

for command in pnpm pi; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: $command is required but was not found in PATH" >&2
    exit 1
  fi
done

if [[ ! -f "$PROMPT_SOURCE" ]]; then
  echo "Error: append-system prompt not found at $PROMPT_SOURCE" >&2
  exit 1
fi

if [[ -L "$PROMPT_TARGET" ]]; then
  if [[ "$(readlink "$PROMPT_TARGET")" != "$PROMPT_SOURCE" ]]; then
    echo "Error: $PROMPT_TARGET already links to another file" >&2
    echo "Move or remove it, then rerun this installer." >&2
    exit 1
  fi
elif [[ -e "$PROMPT_TARGET" ]]; then
  echo "Error: $PROMPT_TARGET already exists and is not a symlink" >&2
  echo "Move or remove it, then rerun this installer." >&2
  exit 1
fi

cd "$SCRIPT_DIR"
pnpm install
pi install .

mkdir -p "$AGENT_DIR"
if [[ -L "$PROMPT_TARGET" ]]; then
  rm "$PROMPT_TARGET"
fi
ln -s "$PROMPT_SOURCE" "$PROMPT_TARGET"

echo "Linked $PROMPT_TARGET -> $PROMPT_SOURCE"
echo "Run /reload in Pi to load APPEND_SYSTEM.md."
