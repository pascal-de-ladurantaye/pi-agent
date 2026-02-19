#!/usr/bin/env bash
#
# Install pi extensions and global AGENTS.md by symlinking into
# all pi agent config directories found in ~/.pi/
#
# Usage: ./install.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="$HOME/.pi"

if [[ ! -d "$PI_DIR" ]]; then
  echo "Error: $PI_DIR does not exist"
  exit 1
fi

installed=0

# ── Render and install global AGENTS.md into each agent profile ──

GLOBAL_AGENTS_TEMPLATE="$SCRIPT_DIR/global-agents.md"
if [[ -f "$GLOBAL_AGENTS_TEMPLATE" ]]; then
  echo "Global AGENTS.md template: $GLOBAL_AGENTS_TEMPLATE"
  RENDERED=$(sed "s|{{REPO_DIR}}|$SCRIPT_DIR|g" "$GLOBAL_AGENTS_TEMPLATE")

  for agent_dir in "$PI_DIR"/*/; do
    [[ -d "$agent_dir" ]] || continue
    agent_name="$(basename "$agent_dir")"
    target="${agent_dir}AGENTS.md"

    # Remove old symlinks from previous install versions
    if [[ -L "$target" ]]; then
      rm "$target"
    fi

    echo "$RENDERED" > "$target"
    echo "  ✅ $agent_name/AGENTS.md (rendered from template)"
    ((installed++))
  done
  echo ""
fi

# ── Symlink extension folders ──

EXT_SRC="$SCRIPT_DIR/extensions"
extensions=()
if [[ -d "$EXT_SRC" ]]; then
  for dir in "$EXT_SRC"/*/; do
    if [[ -f "${dir}index.ts" ]]; then
      extensions+=("$(basename "$dir")")
    fi
  done
fi

if [[ ${#extensions[@]} -eq 0 ]]; then
  echo "No extensions found (looking for extensions/*/index.ts)"
else
  echo "Extensions: ${extensions[*]}"
  for agent_dir in "$PI_DIR"/*/; do
    [[ -d "$agent_dir" ]] || continue
    agent_name="$(basename "$agent_dir")"

    ext_dir="${agent_dir}extensions"
    mkdir -p "$ext_dir"

    for ext in "${extensions[@]}"; do
      source_dir="$EXT_SRC/$ext"
      target="$ext_dir/$ext"

      if [[ -L "$target" ]]; then
        rm "$target"
      elif [[ -e "$target" ]]; then
        echo "  ⚠️  Skip $agent_name/$ext — exists and is not a symlink"
        continue
      fi

      ln -s "$source_dir" "$target"
      echo "  ✅ $agent_name/extensions/$ext → $ext"
      ((installed++))
    done
  done
fi

echo ""
echo "Installed $installed symlink(s). Run /reload in pi to pick up changes."
