# Stop background LLM sessions flooding the TUI with reasoning parts (PR 1346)

## What

Background LLM dispatches (curator, skill-improver, mutation generator, full-auto
oversight/critic, and lean-turbo reviewer/critic/lanes) no longer flood the right-hand
OpenCode TUI session log with internal reasoning text, and no longer risk a foreign-key
crash when a dispatch is cancelled mid-prompt.

- **Child sessions instead of roots (Fix A).** Every background `client.session.create`
  now passes `body: { parentID, title }` when a calling session ID is available, so
  OpenCode treats the ephemeral session as a child of the originating session rather than
  a new top-level root. Root sessions persist all message parts — including
  `ReasoningPart` tokens — into the TUI log; child sessions do not. Sites updated:
  `src/hooks/curator-llm-factory.ts`, `src/hooks/skill-improver-llm-factory.ts`,
  `src/mutation/generator.ts`, `src/full-auto/oversight.ts`,
  `src/hooks/full-auto-intercept.ts`, `src/turbo/lean/reviewer.ts`,
  `src/turbo/lean/integration.ts`, `src/turbo/lean/runner.ts`. When no session ID is
  available the body is omitted and a root session is created as before (graceful
  fallback).
- **Extended thinking disabled for classification agents (Fix B).** `createCuratorAgent`
  and `createCriticAutonomousOversightAgent` now set `thinking: { type: 'disabled' }`.
  These produce verdict/classification output, for which extended thinking adds large
  reasoning parts and no value. Users can re-enable via
  `agents.curator_<role>.thinking` / `agents.critic_oversight.thinking` in config. Other
  critic roles are intentionally left unchanged.
- **Native cancellation instead of mid-prompt session deletion (Fix C).** The curator and
  skill-improver factories forward the caller's `AbortSignal` to `session.create` and
  `session.prompt`, and the abort→delete listener was removed. This prevents the FK
  constraint crash that occurred when `cleanup()` deleted a session while OpenCode was
  still writing parts. Timeout-sentinel translation (`CURATOR_LLM_TIMEOUT` /
  `SKILL_IMPROVER_LLM_TIMEOUT`) is now narrowed to genuine cancellation
  (`AbortError`/`TimeoutError`), so a real failure that merely coincides with an aborted
  signal still surfaces as itself.

## Why

Two screenshots showed the TUI's right window filling with the LLM's internal reasoning.
Root cause: background ephemeral sessions were created without a `parentID`, so OpenCode
registered them as root sessions and persisted every part — reasoning included — to the
session log. A secondary crash occurred when an abort/timeout deleted the session
mid-prompt, violating a foreign-key constraint in OpenCode's part writer.

## Migration

No action required. Background dispatches behave identically except that their ephemeral
sessions are now children of the calling session and no longer surface reasoning text in
the TUI. To restore extended thinking for the curator or autonomous-oversight critic, set
`thinking` in the relevant `agents.*` config block.

## Scope / follow-up

`AbortSignal` forwarding (Fix C) is implemented only at the curator and skill-improver
factories, because only those two delegate paths receive an `AbortSignal` from their
callers today. The other six background `session.create` sites correctly create child
sessions (Fix A) but do not yet forward a signal — their callers expose no signal
parameter in the current code. Threading abort plumbing through those call chains is
deferred to a follow-up and is out of scope for this TUI-flooding fix.
