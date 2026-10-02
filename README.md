# pi-agent

Customizations for [pi](https://github.com/badlogic/pi-mono), the coding agent.

This repo is also a Pi package, so you can install it directly with `pi install .` from a local checkout or `pi install git:https://github.com/pascal-de-ladurantaye/pi-agent` from elsewhere.

The package uses Pi's conventional directories via the root `pi` manifest:
- `extensions/`
- `skills/`
- `prompts/`
- `themes/`

## Install

### Local checkout

```bash
./install.sh
```

The installer runs `pnpm install`, registers this checkout with `pi install .`, and links [`APPEND_SYSTEM.md`](./APPEND_SYSTEM.md) to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/APPEND_SYSTEM.md`. Pi appends that file to its default system prompt. The installer refuses to replace a file or unrelated symlink at that path.

Then run `/reload` in Pi.

### Git / remote install

```bash
pi install git:https://github.com/pascal-de-ladurantaye/pi-agent
# or
pi install https://github.com/pascal-de-ladurantaye/pi-agent
```

For git and npm packages, Pi runs `npm install` automatically. Package installation loads extensions, skills, prompts, and themes, but Pi packages do not install global system-prompt files. Use the local-checkout installer when you also want `APPEND_SYSTEM.md`.

### Development workflow

Once you've run `pi install .` for a given Pi profile, local-path packages point at this working tree directly. After most changes, just run `/reload` in pi.

If this repo is not yet installed in the current profile, run:

```bash
pi install .
```

## Extensions

| Extension | Description |
|---|---|
| [bash-guard](./extensions/bash-guard/) | Adversarial security review for bash commands — parallel LLM voters assess safety before execution |
| [cross-agent-discovery](./extensions/cross-agent-discovery/) | Discovers project-local Claude slash commands (`.claude/commands/*.md`) and registers them as pi prompt templates |
| [goal](./extensions/goal/) | Autonomous session goals inspired by Codex `/goal`, with slash commands, model tools, persisted state, and a status widget |
| [hashline](./extensions/hashline/) | Content-anchored line editing — overrides read/grep/edit with `LINE:HASH` references for precise, drift-resistant edits |
| [session-memory](./extensions/session-memory/) | Converts session JSONL to Obsidian-friendly markdown vault with callouts, indexes, canvas, and MOC |
| [session-namer](./extensions/session-namer/) | Auto-names sessions using Claude Haiku on the first 3 turns |
| [snapshot](./extensions/snapshot/) | Shadow-git filesystem checkpoints at each turn; offers file restore on `/fork` |
| [shoulderpeek](./extensions/shoulderpeek/) | Quickly inspect the agent's work, annotate it, and aggregate notes into a follow-up prompt |

## Skills

| Skill | Description |
|---|---|
| [browser-mcp](./skills/browser-mcp/) | Automates the user's real Chrome browser via the Browser MCP Chrome extension — CLI wrapper + daemon that bridges commands to the extension over WebSocket |
| [humanizer](./skills/humanizer/) | Removes signs of AI-generated writing from text to make it sound more natural and human-written |

## Prompt templates

| Prompt | Description |
|---|---|
| [discuss](./prompts/discuss.md) | Adds `/discuss` for exploratory, research-oriented discussion of a topic |

## Themes

| Theme | Description |
|---|---|
| [darcula](./themes/darcula.json) | Dark theme inspired by the JetBrains Darcula IDE theme |
| [nightowl](./themes/nightowl.json) | Dark theme inspired by the Night Owl VS Code theme |

## Uninstall

If you installed this repo as a local package from the repo root:

```bash
pi remove "$(pwd)"
prompt="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/APPEND_SYSTEM.md"
[[ -L "$prompt" && "$(readlink "$prompt")" == "$(pwd)/APPEND_SYSTEM.md" ]] && rm "$prompt"
```

This removes `APPEND_SYSTEM.md` only when it still links to this checkout. Remove the same package path you originally installed. Use `pi list` to inspect installed packages and their sources.

## Append-system prompt

[`APPEND_SYSTEM.md`](./APPEND_SYSTEM.md) contains the body of pstack's [`unslop` skill](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md), without skill frontmatter. Linking it into Pi's global agent configuration makes those writing rules apply to every task instead of loading them only when a skill matches.

## Attribution

- `APPEND_SYSTEM.md` is adapted from Lauren Tan's [pstack `unslop` skill](https://github.com/cursor/plugins/blob/main/pstack/skills/unslop/SKILL.md) and included under the [MIT License](./licenses/pstack-unslop.LICENSE).
- The `humanizer` skill is copied from [blader/humanizer](https://github.com/blader/humanizer) by Siqi Chen and included under the MIT License.
- The hashline approach originates from [oh-my-pi](https://github.com/can1357/oh-my-pi) by [can1357](https://github.com/can1357).

## Adding a new extension

1. Create a folder under `extensions/` with an `index.ts` that exports a default function:
   ```typescript
   import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

   export default function (pi: ExtensionAPI) {
     // ...
   }
   ```
2. Add a `README.md` documenting the extension.
3. If it needs package dependencies, add them to the root `package.json` and run `pnpm install`.
4. Keep runtime files inside the extension folder whenever possible so Pi discovery and packaging pick them up automatically.
5. If you add unusual package-level files, make sure `.npmignore` does not exclude them.
6. Make sure the repo is installed in the target Pi profile with `pi install .`.
7. Run `/reload` in pi.
