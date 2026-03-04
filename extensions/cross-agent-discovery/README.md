# cross-agent-discovery

Discovers project-local Claude slash commands (`.claude/commands/*.md`) and registers them as pi prompt templates via `resources_discover`.

## How it works

- On resource discovery, scans `.claude/commands/` in the project root for `.md` files (non-recursive)
- Each file becomes a `/command` in pi, named after the filename (e.g., `review.md` → `/review`)
- Claude's `$ARGUMENTS` placeholder is natively supported by pi
- Unknown Claude frontmatter fields (`allowed-tools`, `argument-hint`) are silently ignored

## Commands

- `/cross-agent-discovery` — list discovered Claude commands

## Limitations

- Only scans project-local `.claude/commands/` (not `~/.claude/commands/`)
- Subdirectory commands (e.g., `.claude/commands/gt/create-submit.md`) are not supported — only flat `.md` files
