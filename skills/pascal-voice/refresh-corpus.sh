#!/usr/bin/env bash
# Refresh Pascal de Ladurantaye's voice-analysis corpus from local Hermes-style data.
# Outputs to <repo>/.voice-analysis/corpus/ when run inside a git repo.

set -euo pipefail

USER_NAME="Pascal de Ladurantaye"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$PROJECT_DIR/.voice-analysis/corpus"

HERMES_DATA=""
for candidate in "$HOME/vault/work/hermes/data" "$HOME/Documents/hermes-data"; do
  if [ -d "$candidate" ]; then
    HERMES_DATA="$candidate"
    break
  fi
done

if [ -z "$HERMES_DATA" ]; then
  echo "ERROR: No Hermes-style data directory found."
  echo "Checked:"
  echo "  - $HOME/vault/work/hermes/data"
  echo "  - $HOME/Documents/hermes-data"
  exit 1
fi

mkdir -p "$OUT"

echo "Extracting text for: $USER_NAME"
echo "Source: $HERMES_DATA"
echo "Output: $OUT"
echo

# === Slack messages (primary voice source) ===
echo "Extracting Slack messages..."

grep -rh "^\*\*$USER_NAME\*\*" "$HERMES_DATA/slack/" 2>/dev/null | \
  sed "s/^\*\*$USER_NAME\*\* ([^)]*): //" | \
  grep -v 'has joined the channel\|archived the channel\|^$' \
  > "$OUT/slack_all.txt" || true

find "$HERMES_DATA/slack/" -name 'channel-*.md' \
  -exec grep -h "^\*\*$USER_NAME\*\*" {} + 2>/dev/null | \
  sed "s/^\*\*$USER_NAME\*\* ([^)]*): //" | \
  grep -v 'has joined\|archived the\|^$' \
  > "$OUT/slack_channels.txt" || true

find "$HERMES_DATA/slack/" -name 'dm-*.md' \
  -exec grep -h "^\*\*$USER_NAME\*\*" {} + 2>/dev/null | \
  sed "s/^\*\*$USER_NAME\*\* ([^)]*): //" | \
  grep -v 'has joined\|archived the\|^$' \
  > "$OUT/slack_dms.txt" || true

grep -rh "^> \*\*$USER_NAME\*\*" "$HERMES_DATA/slack/" 2>/dev/null | \
  sed "s/^> \*\*$USER_NAME\*\* ([^)]*): //" | \
  grep -v '^$' \
  > "$OUT/slack_threads.txt" || true

# === Claude / Pi prompts (instructional voice) ===
echo "Extracting AI prompts..."

prompt_dirs=()
[ -d "$HERMES_DATA/claude" ] && prompt_dirs+=("$HERMES_DATA/claude")
[ -d "$HERMES_DATA/pi" ] && prompt_dirs+=("$HERMES_DATA/pi")

if [ ${#prompt_dirs[@]} -gt 0 ]; then
  find "${prompt_dirs[@]}" -name 'sessions.md' \
    -exec grep -h '^[0-9]*\. ' {} + 2>/dev/null | \
    sed 's/^[0-9]*\. //' \
    > "$OUT/prompts.txt" || true
else
  : > "$OUT/prompts.txt"
fi

# === GitHub data ===
echo "Extracting GitHub data..."

grep -rh '^  - `' "$HERMES_DATA/github/" 2>/dev/null | \
  sed 's/^  - `[^`]*`: //' \
  > "$OUT/review_comments.txt" || true

grep -rh '| shop/world\|| Shopify/' "$HERMES_DATA/github/" 2>/dev/null | \
  awk -F'|' '{print $4}' | sed 's/^ *//' | grep -v '^$' \
  > "$OUT/commit_messages.txt" || true

find "$HERMES_DATA/github/" -name 'activity.md' \
  -exec awk '/^### PRs Authored/,/^### [^P]/{print}' {} + 2>/dev/null | \
  grep '^####' | sed 's/^#### \[.*\]: //' \
  > "$OUT/pr_titles.txt" || true

# === Google Drive docs (long-form, lower-confidence voice source) ===
echo "Extracting Google Drive docs..."

if [ -d "$HERMES_DATA/gdrive" ]; then
  find "$HERMES_DATA/gdrive/" -name '*.md' -exec cat {} + 2>/dev/null | \
    sed -n '/^#### Content/,/^##/p' | grep -v '^####\|^##' \
    > "$OUT/gdrive_content.txt" || true
else
  : > "$OUT/gdrive_content.txt"
fi

echo
echo "========================================="
echo "  Corpus Extraction Complete"
echo "========================================="
echo

total_words=0
for f in "$OUT"/*.txt; do
  name="$(basename "$f" .txt)"
  lines="$(wc -l < "$f" 2>/dev/null | tr -d ' ')"
  words="$(wc -w < "$f" 2>/dev/null | tr -d ' ')"
  total_words=$((total_words + words))
  printf "  %-20s %6s lines  %7s words\n" "$name" "$lines" "$words"
done

echo
echo "  TOTAL: $total_words words"
echo

slack_lines="$(wc -l < "$OUT/slack_all.txt" 2>/dev/null | tr -d ' ')"
if [ "$slack_lines" -lt 1000 ]; then
  echo "  ⚠️  WARNING: Only $slack_lines Slack messages found."
  echo "  For a strong voice profile, 1,000+ messages is a good floor."
  echo
fi

echo "  Output saved to: $OUT/"
