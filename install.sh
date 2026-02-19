#!/usr/bin/env bash
#
# Install pi extensions by symlinking each extension folder
# into all pi agent config directories found in ~/.pi/
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

# Find all extension folders (directories containing index.ts)
extensions=()
for dir in "$SCRIPT_DIR"/*/; do
  if [[ -f "${dir}index.ts" ]]; then
    extensions+=("$(basename "$dir")")
  fi
done

if [[ ${#extensions[@]} -eq 0 ]]; then
  echo "No extensions found (looking for */index.ts)"
  exit 0
fi

echo "Found extensions: ${extensions[*]}"
echo ""

# Find all agent config directories in ~/.pi/
installed=0
for agent_dir in "$PI_DIR"/*/; do
  [[ -d "$agent_dir" ]] || continue
  agent_name="$(basename "$agent_dir")"

  # Create extensions directory if needed
  ext_dir="${agent_dir}extensions"
  mkdir -p "$ext_dir"

  for ext in "${extensions[@]}"; do
    source_dir="$SCRIPT_DIR/$ext"
    target="$ext_dir/$ext"

    # Remove existing symlink or warn about non-symlink conflicts
    if [[ -L "$target" ]]; then
      rm "$target"
    elif [[ -e "$target" ]]; then
      echo "  ⚠️  Skip $agent_name/$ext — target exists and is not a symlink"
      continue
    fi

    ln -s "$source_dir" "$target"
    echo "  ✅ $agent_name/extensions/$ext → $source_dir"
    ((installed++))
  done
done

echo ""
echo "Installed $installed symlink(s). Run /reload in pi to pick up changes."
