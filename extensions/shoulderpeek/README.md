# Shoulderpeek

Shoulderpeek is for quickly seeing what the agent just did, annotating the work, and aggregating those notes into a follow-up prompt.

Views currently available:

- `diff` — a Git diff browser with a changed-file tree on the left and an inline diff pane on the right
- `code` — a code explorer rooted at `ctx.cwd`, with a filesystem tree on the left and a file preview on the right
- `notes` — a shared pending-notes view for both code and diff annotations

## Commands

- `/shoulderpeek` opens the default `diff` view
- `/shoulderpeek diff` opens the diff view explicitly
- `/shoulderpeek code` opens the code view rooted at the current working directory

## What it's for

Use shoulderpeek when you want to:

- quickly inspect the agent's latest changes
- jump between changed files and full file context
- annotate lines or ranges while you review
- collect nitpicks without interrupting the flow
- aggregate those notes into a clean follow-up prompt in Pi's main editor

## Features

- Switch between `diff` and `code` without leaving shoulderpeek
- Tree + content layout with keyboard-first navigation
- Bottom-aligned, full-width inline note editor inside the content pane
- Pending-notes call to action in the header
- Shared notes list with jump, edit, delete, and review flows
- `?` shortcut help in code, diff, and notes views
- Git-aware code explorer that respects Git ignore rules when inside a repository
- Uses **delta** when available for diff browsing
- Falls back to Pi's inline diff renderer when delta is unavailable or unsuitable
- Status badges for:
  - `S` staged changes
  - `U` unstaged changes
  - `?` untracked files
  - `R` renames
  - `C` conflicts

## Shared controls

- `↑` / `↓` — move the tree selection or the focused content line
- `Enter` / `→` — open the selected file or expand a directory from the tree
- `←` — return to the tree, collapse a directory, or select its parent
- `Tab` — switch between the tree and content panes when a file is selected
- `v` — switch between `diff` and `code`
- `t` — toggle the tree pane
- `PageUp` / `PageDown` — page through the preview or focused content
- `Home` / `End` — jump to top / bottom
- `?` — show the shortcut help screen
- `r` — refresh the current view
- `Esc` / `q` — close shoulderpeek

## Annotation controls

- `Space` — start a range from the current line, or clear the active range
- `a` — open the inline multiline note editor for the current line or selected range
- `Enter` — save the note when the inline editor is open
- `Shift+Enter` — insert a newline inside the note
- `Esc` — cancel the inline note editor
- `Ctrl+G` — open the note in your external editor when configured
- `n` — open the pending notes list when notes exist
- `d` — load pending notes into Pi's input editor for review without sending them yet

Range selection is cleared after you finish or cancel an annotation.

## Diff view controls

- `s` — toggle staged vs unstaged diff when the selected file has both
- `f` — cycle file filter: `all` → `staged` → `unstaged`

## Notes list controls

- `↑` / `↓` — move between pending notes
- `Enter` — jump to the selected note's source location
- `e` — edit the selected note
- `x` — delete the selected note
- `d` — review all pending notes in Pi's input editor
- `?` — show the notes help screen
- `Esc` / `q` — return to the previous shoulderpeek view

## Review draft format

Reviewing pending notes loads them into Pi's main input editor in this shape:

```text
path:line-or-ref
```
excerpt
```

The content of the annotation note
```

Multiple notes are separated by:

```text
---
```

## Notes

- The `diff` view only works inside a Git repository.
- The `code` view is rooted at `ctx.cwd`, ignores `.git`, `node_modules`, and `.DS_Store`, and respects Git ignore rules when possible.
- When pending notes exist, the header shows a call to action for opening the notes list or reviewing them in Pi's input editor.
- The inline note editor temporarily pauses shoulderpeek-level shortcuts and shows its own editor hints.
- Diff annotation mode uses Pi's stable inline diff model, even when delta is available for normal browsing.
- When Pi's fallback renderer is used, binary and conflict-heavy diffs may degrade to explanatory messages instead of a rendered patch.
