# Goal

Autonomous session goals for Pi, inspired by Codex's `/goal` feature.

## What it does

- Adds `/goal` slash command for persistent session goals.
- Adds model tools:
  - `goal_get`
  - `goal_create`
  - `goal_update`
- Persists goal state in Pi session custom entries, so state follows the current branch across `/fork` and `/tree`.
- Shows a detailed widget below the editor with objective, status, autonomous mode, and continuation count.
- Defaults to autonomous continuation: an active autonomous goal keeps triggering follow-up turns until the model marks it complete or the user pauses/clears it.
- Detects interrupted agent runs (for example, pressing Escape while the agent is running) and pauses the active goal instead of auto-continuing.
- Keeps explicit goal events visible, while routine agent-end continuations stay quiet except for periodic visible checkpoints.
- Does not inject recurring active-goal reminders into ordinary turns; model-visible goal context is reserved for continuations and objective edits.
- Does not implement token/time budgeting yet.

## Commands

```text
/goal
/goal status
/goal <objective>
/goal edit
/goal edit <objective>
/goal pause
/goal resume
/goal clear
/goal complete
/goal auto on
/goal auto off
/goal max <positive-integer|off>
```

`/goal <objective>` creates or replaces the current goal and immediately starts autonomous work.

`/goal max` is optional. By default there is no maximum continuation cap. If set, the extension pauses the goal after that many autonomous continuations.

## Model tool boundary

The model can inspect and create goals, but only when explicitly instructed. The model can only update a goal by marking it complete:

```json
{"status":"complete"}
```

Pause, resume, clear, and replacement remain user/system controlled.

## Persistence

Goal snapshots are stored with:

```ts
pi.appendEntry("goal", { event, goal })
```

On session start or tree navigation, the extension restores the latest goal snapshot from `ctx.sessionManager.getBranch()` instead of all entries, preserving branch semantics.

## Notes

This extension intentionally omits Codex's token budget and elapsed-time accounting in the first version. The continuation prompt keeps Codex's core completion-audit behavior: the model should only call `goal_update` after verifying the full objective against current evidence.

Routine autonomous continuations are still sent to the model, but they are not all rendered in the transcript. User-facing goal creation, resume/edit updates, session-start restoration, cap pauses, and every fifth routine continuation remain visible so the session stays explainable without repetitive “continuing the goal” chatter. Ordinary user turns do not receive an extra active-goal reminder.
