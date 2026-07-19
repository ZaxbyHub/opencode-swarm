# Knowledge enforcement gate — deadlock escape hatch + ack-marker regex fix

## What

`knowledgeApplicationGateBefore` (`src/hooks/knowledge-application-gate.ts`)
could permanently block high-risk architect tool calls (`save_plan`,
`update_task_status`, `phase_complete`, `task`/`Task` under the production
default config) once a critical knowledge directive landed in
`swarmState.currentCriticalShownIds` for a session, if the acknowledgment
never made it into `swarmState.knowledgeAckDedup`. There was no timeout,
retry limit, or staleness check — a single ack that failed to parse meant
the architect could never take another high-risk action for the rest of
the session.

(`skill_regenerate`/`skill_retire` are declared in the source-level
`HIGH_RISK_TOOLS` constant, but under the production default config path —
`KnowledgeApplicationConfigSchema.parse(...)` — the Zod-defaulted
`config.high_risk_tools` (5 tools) is always truthy and therefore always
shadows that 7-tool fallback constant; those two tools are not actually
gated unless an operator explicitly adds them via config. This shadowing is
pre-existing on `main` and out of scope for this fix.)

Two independent causes fed the deadlock:

1. **Regex bug.** The `ACK_PATTERN` in `src/hooks/knowledge-application.ts`
   required a strict lookahead after the directive ID (`$`, a newline, or
   `\s+KNOWLEDGE_`). A marker like `KNOWLEDGE_APPLIED: <id> - I applied this.`
   failed to parse because the trailing explanation text didn't match any of
   the three accepted terminators.
2. **No escape hatch.** Even with a correctly-formatted marker, any other
   failure in the ack pipeline (a retrieval bug, a hook error swallowed by
   `composeHandlers`, a session/transform ordering edge case) left the gate
   with no recovery path in `enforce` mode.

## Fix

- Relaxed `ACK_PATTERN`'s outer lookahead from `(?=$|[\n\r]|\s+KNOWLEDGE_)` to
  `(?=[^0-9a-fA-F-]|$)`, so a marker followed by punctuation, a parenthetical,
  or free-text explanation now parses correctly. The reason-capture group
  keeps its own tighter lookahead so `reason=...` text is not truncated by
  the relaxation.
- Added two escape hatches to `knowledgeApplicationGateBefore`, both gated
  behind new optional `KnowledgeApplicationConfig` fields
  (`src/config/schema.ts`, `src/hooks/knowledge-application.ts`):
  - `max_gate_denials` (default `5`) — after this many consecutive denials
    against the *same* unacknowledged critical-directive set for a session,
    the gate auto-acknowledges the pending directives as `applied`, clears
    them for that session, and lets the action through.
  - `gate_staleness_ms` (default `600_000`, 10 minutes) — a directive shown
    longer ago than this is treated as stale and auto-cleared the same way.
  - Both escapes `await` an auditable `knowledge_application_gate_denial_limit_clear`
    / `knowledge_application_gate_staleness_clear` event write to
    `.swarm/events.jsonl` before returning, so the bypass state and its audit
    record commit together — a write failure cannot leave the bypass silently
    unaudited.
- The per-session denial counter (`swarmState.gateDenialCounts`, a new
  `Map<string, { count, directiveKey }>` alongside the pre-existing
  `currentCriticalShownIds`/`knowledgeAckDedup` maps in `src/state.ts`,
  managed via `incrementGateDenialCount`/`clearGateDenialCount`) is
  **identity-scoped**: each entry also records a fingerprint
  (`buildGateDenialDirectiveKey`, a sorted join of the directive-id set) of
  which critical-directive set the count was accrued against. This closes a
  cross-directive leak found in review: without identity-scoping, denials
  accrued against one unacknowledged directive would silently carry over and
  count toward an unrelated directive's budget when the injector swaps in a
  new critical-directive set on an ordinary phase/task transition (via the
  pre-existing `setCriticalShownIds`) — letting the new directive get
  auto-cleared after far fewer than `max_gate_denials` real denials against
  it. Re-injecting the *same* directive set across turns (the injector
  re-stamps `generatedAt` on every cache-hit re-injection) does not reset the
  count, since the identity key is the directive-id set, not the timestamp.
  `gateDenialCounts` is FIFO-bounded to 500 entries
  (`MAX_TRACKED_GATE_DENIALS`) and is cleared by `resetSwarmState()`
  alongside its sibling maps, closing a second review finding where the
  counter survived a same-process `/swarm close` and leaked into a reused
  session.
- The escape-hatch branches now clear `currentCriticalShownIds` via the
  existing centralized `clearCriticalShownIds()` helper (`src/state.ts`)
  instead of a direct `Map.delete()`, matching every other call site.
- Corrected a stale doc comment on `swarmState.knowledgeAckDedup`
  (`src/state.ts`) that claimed the dedup key included a `dayKey` component;
  the actual implementation (`buildAckDedupKey`,
  `src/hooks/knowledge-application.ts`) never included one — confirmed by the
  existing `GATE-002` regression test, which asserts a prior-day ack still
  satisfies the same-session gate.
- Updated `docs/knowledge.md`'s "Enforcement modes" section and the
  architect system prompt (`src/agents/architect.ts`) to describe the two
  new escape hatches instead of stating enforce mode blocks unconditionally.

## Migration

No migration required. Both new config fields are optional with defaults
that preserve today's behavior for the first 5 denials / 10 minutes; only
sessions that would previously have deadlocked see different behavior, and
only after exhausting the configured grace period.

## Known caveats

- The denial-count and staleness escape hatches are safety nets, not a
  routine escape path: enforcement still applies for the first
  `max_gate_denials` attempts against a given directive set, or the full
  `gate_staleness_ms` window, and every auto-clear is logged.
- The staleness clock measures time since the directive was *last shown*
  (`cached.generatedAt`), not time since it was *first* shown — the injector
  re-stamps this on every cache-hit re-injection of the same directive set.
  The denial-count hatch remains a functioning backstop for turns that
  actually retry the gated tool call.
- `knowledge_receipt` still intentionally does not satisfy the gate — only
  chat-text `KNOWLEDGE_APPLIED`/`IGNORED`/`VIOLATED` markers do. This is an
  existing, unchanged design decision, not a regression.
