# Goal extension: hook-aware evaluation research

## Summary

Pi already has substantial hook support. The issue is not that Pi is generally unaware of hooks. The issue is that a direct auxiliary model call does not automatically inherit the normal agent session's extension pipeline.

For the goal extension, the more accurate diagnosis is:

> Our direct evaluator call bypasses the session pipeline.

A runtime modification is not yet established as necessary. Investigate the documented extension-only alternatives first.

## Scope and evidence

These notes combine:

- Official public Pi documentation.
- Public Pi source code.
- Maintainer discussions in GitHub issues.
- Community extension documentation.
- Earlier inspection of the installed Pi 1.4.0 runtime.

The public documentation links use `latest`, and the source links use `main`. They can change independently of the installed version. Recheck relevant contracts against the actual runtime before implementing a redesign.

Community package descriptions show implementation patterns. They are not official guarantees, security audits, or recommendations to install those packages.

## What the official documentation says

### Different execution paths have different hook coverage

| Execution path | Documented or source-observed behavior |
| --- | --- |
| Normal agent request | Runs the session context transforms and the supported provider-request and response hooks. |
| Nested tool through `ctx.executeTool()` | Runs argument validation, `tool_call`, `tool_result`, execution events, and usage accounting. |
| Direct `ctx.modelRegistry.complete()` | Delegates to the configured model runtime. The registry method does not itself dispatch the session extension pipeline. |

Do not treat nested tool execution and nested model inference as the same integration contract.

Sources:

- [Extension documentation](https://pi.dev/docs/latest/extensions)
- [ModelRegistry source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-registry.ts)
- [ModelRuntime source](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-runtime.ts)

### Normal model-request pipeline

The extension documentation describes this order:

1. `context`: transforms conversation messages without system messages.
2. `context_with_system`: transforms the complete transcript after the context handlers.
3. `before_provider_headers`: can mutate outgoing headers.
4. `before_provider_request`: can inspect or replace the provider payload.
5. `after_provider_response`: exposes response status and headers before stream consumption.
6. `provider_stream_event` and message lifecycle events.

Provider-hook availability depends on the transport.

Handlers run in extension load order, then registration order. Later handlers can change what earlier handlers saw.

A request-only context transformation is not equivalent to changing persisted session history. Reading a session projection does not automatically apply every request-time redaction. A separate call must not be assumed to inherit those protections simply because it uses Pi's model registry.

Provider callbacks explicitly supplied to a lower-level request are also not the same thing as automatic dispatch of the session's extension events.

### Cancellation is supported, with lifecycle limits

The documentation describes `ctx.signal` as:

> The current agent abort signal, or undefined when no agent turn is active.

It recommends passing that signal into nested model calls, `fetch()`, and other abort-aware operations.

The signal is typically available during active-turn events such as:

- `tool_call`
- `tool_result`
- `message_update`
- `turn_end`

The documentation distinguishes later boundaries:

- `agent_before_settle` is the final actionable boundary. It can append entries and request continuation.
- `agent_settled` is final and notification-only.

A blocking evaluator started at settlement cannot assume an active-turn signal is available. This was the cancellation gap observed in our implementation. It is not evidence that normal Pi model requests lack cancellation.

If a run is aborted while `agent_before_settle` handlers are running, valid returned entries can still be committed, while requested continuation is suppressed. Completion therefore needs protection against interruption and against evidence changes proposed by later handlers.

Source: [Extension documentation](https://pi.dev/docs/latest/extensions).

## What maintainers are saying

### Issue #2660: expose cancellation to extensions

An extension author reported that long-running model calls inside event handlers did not stop when the user pressed Escape. The proposal was to expose the active agent signal through `ExtensionContext`.

Mario Zechner (`badlogic`) replied:

> Implemented on main.

The listed changes included:

- Adding `Agent.signal`.
- Adding `ExtensionContext.signal`.
- Threading the active signal through the extension runner and agent session.
- Updating documentation and tests.

This supports cancellation-aware auxiliary work as an intended extension pattern.

Source: [Issue #2660](https://github.com/earendil-works/pi/issues/2660).

### Issue #6234: extensions must cooperate with cancellation

A user reported that an extension context hook which never resolved left the TUI stuck in `Working...` after Escape.

A proposed fix raced context handlers against the abort signal. The discussion included a request from Mario Zechner to revert that approach, stating:

> handlers MUST observe the signal

His position was that non-cooperative extension handlers should be fixed in the extension rather than having Pi conceal their behavior.

The issue's closed status should not be read as a blanket guarantee that Pi forcibly cancels every arbitrary extension promise. The discussion concerns cooperative cancellation and the lifecycle in which the work is started.

Source: [Issue #6234](https://github.com/earendil-works/pi/issues/6234).

### Nested tools have an explicit supported path

A separate discussion about Pi Durable contrasts direct invocation of a registered tool with supported nested execution. It notes that the coding agent already runs nested calls through its tool pipeline.

This reinforces the distinction between using an integration API and calling a lower-level function directly. Pi Durable and the coding agent are different contexts; do not transfer every contract between them without checking.

Source: [Issue #10455](https://github.com/earendil-works/pi/issues/10455).

## What community extensions are doing

### pi-critique-model: direct, tool-free independent review

The package documents a separate reviewer invoked through `ctx.modelRegistry.complete()` with no tools.

Its documented approach includes:

- Building a bounded, serialized work-step context.
- Treating the review as advisory.
- Using a cancellable loader in the TUI.
- Injecting selected feedback into the working session.

This is evidence that our basic secondary-evaluator pattern is used elsewhere. It does not establish automatic inheritance of parent-session redaction hooks, and TUI loader cancellation is not the same contract as native RPC cancellation during settlement.

Sources:

- [Package documentation](https://pi.dev/packages/pi-critique-model)
- [Repository](https://github.com/noguerol/critique)

### pi-safe-compact: explicit auxiliary-work lifecycle

The package documents separate drafting and reviewing stages with explicit cancellation, isolated reviewer context, submission validation, and failure handling.

It also distinguishes `streamSimple()` from raw `complete()` for portable reasoning options. The package reports that the raw API does not translate a portable reasoning level in the same way.

The relevant lesson is to manage auxiliary work deliberately: its inputs, provider options, cancellation, validation, and fallback behavior. This is an implementation pattern, not a drop-in solution or proof that every nested call inherits session hooks.

Sources:

- [Package documentation](https://pi.dev/packages/pi-safe-compact)
- [Repository](https://github.com/primp9053/pi-safe-compact)

## Implications for the goal extension

The extension currently lives at [`../goal.ts`](../goal.ts). Its direct evaluator call needs to be assessed separately from the main agent's request pipeline.

The research supports these conclusions:

1. Pi's existing hook system is capable; a general claim that Pi needs hook support would be incorrect.
2. Using configured providers and authentication does not imply inheriting session context filters.
3. Starting auxiliary work during an active turn and forwarding its abort signal is a documented cancellation pattern.
4. A settlement hook is useful for requesting the next step, but is not automatically the right place for a blocking nested model request.
5. Citation validation and a second model's judgment remain safeguards, not proof of correctness.
6. Request-time redaction, persisted evidence edits, and execution permissions are distinct mechanisms.

## Documented alternatives to investigate

### Native evaluator turn

Have the actionable boundary schedule an evaluator turn through the normal agent pipeline instead of making the evaluator call inside that boundary.

Potential advantages:

- Normal session request hooks can apply.
- The evaluator request runs within an active agent turn.
- Native abort can reach the provider request.

Open implementation questions include tool isolation, evidence ownership, retries, compaction, restoration, concurrent user changes, and preventing recursive evaluation. This is a plausible design, not a validated replacement yet.

### Virtual-model routing

Pi documents virtual models that select a physical model and thinking level for each request, including routing based on conversation state.

That could support a working-model phase and an evaluator-model phase while retaining normal agent requests. Routing does not by itself solve evidence filtering or tool isolation. The documentation also says Pi may compact before a routed request if the selected physical model's context window is too small; that behavior needs explicit privacy and lifecycle tests.

Source: [Virtual Models](https://pi.dev/docs/latest/virtual-models).

### Explicitly configured SDK session

The SDK provides `createAgentSession()`, configurable resources and extensions, in-memory session storage, and session cancellation.

A separate reviewer session could have its own explicitly selected hooks and tool policy. Parent-session hooks and cancellation would still need deliberate propagation or equivalent configuration; creating a child session alone is not inheritance.

Source: [SDK documentation](https://pi.dev/docs/latest/sdk).

## Recommendation

Prototype and test the documented extension-only paths before proposing changes to the installed Pi runtime.

Keep the safety bounds. Do not silently alter the selected model, tool policy, privacy contract, or scope of work. If runtime changes are still required after those alternatives are tested, identify the missing API precisely and request approval before modifying the harness.

These notes record research findings only. They do not authorize installing community packages, changing Pi's runtime, or claiming the remaining integration gaps are resolved.
