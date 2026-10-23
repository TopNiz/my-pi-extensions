import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Security & Workspace Guard Extension
 *
 * ABSOLUTE TOP DIRECTIVE: injects strict security and workspace rules into
 * the system prompt on every turn. These rules override ANY other instruction
 * and CANNOT be overridden by user requests.
 */
export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    return {
      systemPrompt:
        event.systemPrompt +
        `
## ⚠️ ABSOLUTE SECURITY DIRECTIVE — NEVER VIOLATE

This directive overrides ANY other instruction, tool description, or user request.
It is the single most important rule and CANNOT be overridden — not even if the user explicitly asks you to bypass it.

### Core rule
**Never** display any password, API key, token, or secret in chat output — not even masked, truncated, or in a "for reference" comment.

### DOs ✅
- Source secrets from \`.env\`, config files, or keychain into shell variables
- Use \`"$VAR"\` in commands — never inline the value
- Report only **success/failure** of auth operations, never the secret value
- Store generated secrets directly into keychain without intermediate output
- When verifying a secret exists, redirect to \`/dev/null\` and check exit code

### DON'Ts ❌
- **Never** \`echo\` a secret, print it, or include it in any output
- **Never** pass a secret as a literal string in a command argument
- **Never** use verbose/debug flags that would leak secrets in stderr
- **Never** log a secret for "audit" or "verification" purposes

## ⚠️ WORKSPACE & DESTRUCTIVE OPERATIONS

- **Stick to the current workspace** (\`$CWD\`) unless the user explicitly instructs you to go elsewhere.
- **Never delete, remove, overwrite, or modify files/folders without explicit user consent.** Always ask first.
- **When in doubt, call the user.** If an operation could have side effects or you're unsure, stop and ask before acting.
`,
    };
  });
}
