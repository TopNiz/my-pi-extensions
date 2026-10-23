# my-pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev), loaded globally from `~/.pi/agent/extensions/`.

| Extension | Purpose |
|---|---|
| `boundaries.ts` | Injects absolute boundaries: no unconfirmed email sending, no destructive actions without consent, only touch owned resources. |
| `secrets-guard.ts` | Injects strict secret-handling and workspace rules into every turn. |
| `strict-execution.ts` | Requires doing exactly what was asked and asking before any extra action. |
| `subagent/` | Subagent tooling (single, parallel, and chained execution with isolated context). |
| `goal.ts` | `/goal` mode: autonomous multi-turn work with a secondary evaluator model, session persistence, turn/time bounds, and `goal-clear`/`goal-status` commands. |

## Install

Clone into Pi's global extensions directory:

```bash
git clone git@github.com:TopNiz/my-pi-extensions.git ~/.pi/agent/extensions
```

Pi loads these in every session. Restart Pi, or run `/reload`, after changing files.

## Known issue

`goal.ts` currently cannot evaluate goals: it spawns the evaluator with a `-b` flag that Pi's CLI does not accept, so every evaluation fails and the goal is steered indefinitely. Tracked in the repository issues; do not rely on `/goal` until it is fixed.

## License

Private personal configuration, published for reference. No warranty.
