# knowledge-gate: make the `KNOWLEDGE_ENFORCE_GATE_DENY` ack format self-discoverable

## What changed

The `KNOWLEDGE_ENFORCE_GATE_DENY` denial thrown by `src/hooks/knowledge-application-gate.ts`
when an architect attempts a high-risk action with an unacknowledged critical
knowledge directive now:

- Renders unacknowledged memberships in a single canonical **colon** pair form
  (`<trace_id>:<entry_id>`), matching the ack grammar — previously they were
  shown as slash pairs (`trace/entry`) while the ack demanded colons.
- Lists all five valid ack verbs (`KNOWLEDGE_APPLIED`, `KNOWLEDGE_IGNORED`,
  `KNOWLEDGE_CONTRADICTED`, `KNOWLEDGE_N_A`, `KNOWLEDGE_VIOLATED`) with their
  exact token grammar.
- Emits one fully-instantiated, copy-pasteable ack line per unacknowledged
  membership (`KNOWLEDGE_N_A:<trace_id>:<entry_id> reason=<reason>`), so the
  architect can acknowledge correctly on the first retry instead of guessing the
  format.
- Surfaces the directive lesson content being acknowledged (looked up from the
  knowledge store, best-effort) and, when content is not found, points the agent
  at the most recent `<swarm_knowledge_directives>` block or `knowledge_recall`.

## Why

On v7.144.6 an architect misparsed the slash pair as two entry IDs, acked a
wrong trace (rejected), and the correct recovery was undiscoverable until a
post-hoc source read — wasting two delegations and ~10 idle minutes for a gate
whose satisfaction was three tokens sitting in the denial text all along.

## Migration

No migration required. Enforcement semantics, exact-pair integrity, and the two
bounded escape hatches (staleness TTL, denial-count clear) are unchanged. The
audit `events.jsonl` internal pair formatting and the `swarmState.gateDenialCounts`
keys are unchanged.

## Known caveats

- `docs/knowledge.md` previously documented a legacy one-token ack form
  (`KNOWLEDGE_APPLIED: <id>`) that the V2 gate never accepts; it was corrected
  to the exact-pair colon form in this release to match the deny message and the
  architect prompt guidance.
