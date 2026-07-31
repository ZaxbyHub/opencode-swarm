# Actionable WRITE BLOCKED message for non-coder agents

## What

Resolves #1984. When a non-coder write-capable agent (e.g. `test_engineer`,
`docs`, `designer`, `critic`) attempts to write a file that does not match its
authority rules, the Step 8 `allowedPrefix` block reason now discloses the
agent's own effective allow patterns so the agent can self-correct in one step
instead of looping on filename guessing.

Before:
```
WRITE BLOCKED: Agent "test_engineer" is not authorised to write "phpr-mcp/test-build.mjs". Reason: Path phpr-mcp/test-build.mjs not in allowed list for test_engineer
```

After:
```
WRITE BLOCKED: Agent "test_engineer" is not authorised to write "phpr-mcp/test-build.mjs". Reason: Path phpr-mcp/test-build.mjs not in allowed list for test_engineer. Allowed prefixes: tests/, test/, .swarm/evidence/. Allowed globs: **/tests/**, **/test/**, **/__tests__/**, **/*.test.*, **/*.spec.*, … . Allowed case-sensitive globs: *Test.java, …. Block rules (blocked zones/prefixes/globs/exact) and universal deny paths still apply.
```

The change is a string-only enrichment of the two Step 8 return reasons in
`src/hooks/guardrails/file-authority.ts` (a new module-local `formatAllowedHints`
helper). The hint lists four separate categories — `Allowed exact paths`,
`Allowed prefixes`, `Allowed globs`, and `Allowed case-sensitive globs` (the
case-sensitive category is kept separate so an agent is not misled into a
wrong-case filename, e.g. `contest.java` matching `*Test.java`). Each category
caps at 20 entries (every built-in rule fits) with an accurate `… (+N more)`
tail, and a trailing caveat notes that block rules and universal deny paths
still apply.

Security: the hint discloses ONLY the current agent's own positive permissions —
never `blocked*` rules, universal deny prefixes, or any other agent's policy.

## Why

The previous opaque message named *what* was blocked and *which agent* was
blocked, but never *what would be allowed*. The reason is surfaced verbatim to
the LLM agent (via the fail-closed `tool.execute.before` chain), so an agent had
no way to derive the correct filename without reading plugin source. In the
reporter's run this caused a 3-attempt guess-and-retry loop, each attempt
re-analyzing the codebase and re-running the full test suite — hundreds of
wasted tool calls per occurrence. The aggravator (`declare_scope` being
coder-only by design, so the architect's scope declaration has no effect on
non-coder roles) is unchanged and is a separate, larger enhancement (see
follow-ups).

## Migration

No breaking changes. The literal phrase `Path <path> not in allowed list for
<agent>` is preserved as the reason prefix, so any tooling or assertions that
match on that substring keep working. The appended hint is purely additive.
User-configured per-project authority rules (`guardrails.authority.rules.<agent>`
in `.opencode/opencode-swarm.json`) are surfaced the same way — the hint
reflects the merged effective rules, including overrides.

## Caveats

- This implements Suggested Fix #1 (actionable message) from the issue. The
  issue's larger asks are intentionally out of scope for this change and tracked
  as follow-ups:
  - Fix #2: a write-grant / `declare_scope` extension for non-coder roles (a
    security-sensitive design change; the coder-only bypass is intentional).
  - Fix #3: pre-dispatch validation of declared output files against the target
    agent's authority rules.
  - Fix #4 (broader): per-role write-authority guidance in agent prompts.
- The hint is a necessary-but-not-sufficient guide: a path matching a listed
  allow pattern can still be blocked by a `blocked` rule or universal deny
    prefix. The trailing caveat states this explicitly.
