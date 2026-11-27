# my-pi-extensions

Personal extensions for the [Pi coding agent](https://pi.dev), loaded globally from `~/.pi/agent/extensions/`.

| Extension | Purpose |
|---|---|
| `boundaries.ts` | Injects absolute boundaries: no unconfirmed email sending, no destructive actions without consent, only touch owned resources. |
| `secrets-guard.ts` | Injects strict secret-handling and workspace rules into every turn. |
| `strict-execution.ts` | Requires doing exactly what was asked and asking before any extra action. |
| `subagent/` | Subagent tooling (single, parallel, and chained execution with isolated context). |
| `goal.ts` | Bounded, evidence-checked `/goal` mode with a secondary evaluator, session persistence, work-cycle/time limits, and status/pause/resume/clear commands. Requires Pi 1.4+. |

## Install

Clone into Pi's global extensions directory:

```bash
git clone git@github.com:TopNiz/my-pi-extensions.git ~/.pi/agent/extensions
```

Pi loads these in every session. Restart Pi, or run `/reload`, after changing files.

## Goal mode

Start a goal with `/goal <outcome and verification>`. Use `/goal` or `/goal status` to inspect it, and `/goal pause`, `/goal resume`, or `/goal clear` to control it. The `/goal-status` and `/goal-clear` aliases remain available.

- Defaults: 20 work cycles and 30 active minutes. Trailing `stop after N cycles` or `stop after N minutes` clauses override the corresponding limit. Limits apply at work-cycle boundaries; they do not interrupt running tools.
- Evaluation runs at `agent_before_settle`, after work finishes, through `ctx.modelRegistry.complete()`. It does not spawn a Pi subprocess or evaluate every tool step.
- The tool-free evaluator defaults to `deepseek/deepseek-flash`. Use `--evaluator provider/model` to select another model.
- Completion is confirmed at `agent_settled` only if the run was not aborted and the assessed evidence remains unchanged. This is a model assessment, not independent proof.
- Default verification requires a cited tool result. Use `--text-only` for inspectable text deliverables. Invalid or unavailable assessments pause the goal; exhausted limits stop further goal cycles.
- Restored active goals remain paused until `/goal resume`. A goal never grants additional permissions.

### Evidence privacy and cancellation

Goal-owned observations are sent to the selected evaluator provider. The separate evaluator call bypasses normal request hooks: request-only redactions and later boundary hooks do not protect its input. Only committed or earlier boundary projection edits affect the evidence before it is sent. Tool output must already be safe to share; this extension is not a secret scrubber.

Use `/goal pause` or `/goal clear` for prompt evaluator cancellation. Native RPC/session abort during evaluation may wait up to the 30-second evaluator timeout. Pause, clear, and limits do not stop running tools.

## License

Private personal configuration, published for reference. No warranty.
