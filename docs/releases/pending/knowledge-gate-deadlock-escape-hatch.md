# Knowledge enforcement gate — deadlock escape hatch + ack-marker regex fix

## What

`knowledgeApplicationGateBefore` (`src/hooks/knowledge-application-gate.ts`)
could permanently block every high-risk architect tool call (`save_plan`,
`update_task_status`, `phase_complete`, `task`/`Task`, `skill_regenerate`,
`skill_retire`) once a critical knowledge directive landed in
`swarmState.currentCriticalShownIds` for a session, if the acknowledgment
never made it into `swarmState.knowledgeAckDedup`. There was no timeout,
retry limit, or staleness check — a single ack that failed to parse meant
the architect could never take another high-risk action for the rest of
the session.

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
    for a session, the gate auto-acknowledges the pending directives as
    `applied`, clears `currentCriticalShownIds` for that session, and lets
    the action through.
  - `gate_staleness_ms` (default `600_000`, 10 minutes) — a directive shown
    longer ago than this is treated as stale and auto-cleared the same way.
  - Both escapes write an auditable `knowledge_application_gate_denial_limit_clear`
    / `knowledge_application_gate_staleness_clear` event to `.swarm/events.jsonl`
    before returning, so the auto-clear is never silent.
  - The per-session denial counter (`_gateDenialCounts`, a module-scoped
    `Map<string, number>` in `knowledge-application-gate.ts`) is FIFO-bounded
    to 500 entries and self-cleans whenever a session has no pending critical
    IDs or its directives become acknowledged — no explicit cross-module
    import into `resetSwarmState` was needed.
- Corrected a stale doc comment on `swarmState.knowledgeAckDedup`
  (`src/state.ts`) that claimed the dedup key included a `dayKey` component;
  the actual implementation (`buildAckDedupKey`,
  `src/hooks/knowledge-application.ts`) never included one — confirmed by the
  existing `GATE-002` regression test, which asserts a prior-day ack still
  satisfies the same-session gate.

## Migration

No migration required. Both new config fields are optional with defaults
that preserve today's behavior for the first 5 denials / 10 minutes; only
sessions that would previously have deadlocked see different behavior, and
only after exhausting the configured grace period.

## Known caveats

- The denial-count and staleness escape hatches are safety nets, not a
  bypass: enforcement still applies for the first `max_gate_denials`
  attempts or `gate_staleness_ms` window, and every auto-clear is logged.
- `knowledge_receipt` still intentionally does not satisfy the gate — only
  chat-text `KNOWLEDGE_APPLIED`/`IGNORED`/`VIOLATED` markers do. This is an
  existing, unchanged design decision, not a regression.
