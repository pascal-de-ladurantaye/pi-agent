# Session Namer

Automatically names sessions using Claude Haiku. Runs on the first 3 agent turns, refining the name as more context becomes available. Skips already-named sessions (e.g., resumed ones).

The name appears in the `/resume` session selector instead of the first message, and is picked up by [session-memory](../session-memory/) for index titles and MOC labels.

## How it works

- Hooks `agent_end` for the first 3 turns
- Sends the full conversation context (user/assistant messages) to Claude Haiku
- Calls `pi.setSessionName()` with the result (stored as `session_info` entry in the JSONL)
- Uses `ctx.modelRegistry.find()` to respect user's proxy/key config

## Commands

- `/session-namer name` — force (re)name the current session

## System prompt

The model is instructed to be a "title generator" that outputs only a 5-10 word title. The conversation is wrapped in `<conversation>` XML tags to prevent the model from responding to the content. Output is post-processed: first line only, markdown `#` prefixes stripped.

## Configuration

Hardcoded to `anthropic/claude-haiku-4-5`. Change `PROVIDER` and `MODEL_ID` constants to use a different model.
