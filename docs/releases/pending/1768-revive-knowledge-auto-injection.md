# Revive knowledge auto-injection & fix outcome attribution (#1768)

## What

Resolves issue #1768 (PR 1/8 of the 2026-07-09 knowledge/skill audit). The
architect knowledge auto-injection path had never produced a non-empty result in
production, leaving the entire outcome-feedback chain (shown → applied/ignored →
succeeded/failed → confidence/promotion/decay) dark — every entry had
`shown_count = 0`, and `.knowledge-shown.json` / `knowledge-application.jsonl`
were never created. This PR makes the dead path diagnosable, hardens recording,
and fixes three attribution-integrity defects so the revived loop feeds clean
data.

## Why (root cause, honestly)

The dead path is a **silent-return problem**: multiple early-return guards in
the architect injection hook (headroom-budget, no-agent, not-architect) returned
with **zero telemetry**, so production left no `.swarm` trace of which guard
fired. A single proximate cause could not be pinned statically (agent-recognition
and phase-detection candidate causes were disproved; the agent gate already
handles prefixed names). The fix is the issue's own 2-step strategy: add
structured reason-telemetry to every guard, then harden the recording so the
revived path records correctly.

## Changes

**L1 — diagnosability + recording hardening:**
- Every silent early-return in `createKnowledgeInjectorHook` now emits a
  structured `injection_skip` event (`knowledge-events.jsonl`) with a machine-
  readable `reason` (`headroom_budget`, `no_agent_name`, `not_architect`,
  `no_matching_entries`, `rendered_id_match_failed`). The actual fired guard is
  now recoverable from `.swarm` data on the next session.
- `cachedShownIds` (the set recorded as "shown") is now derived **structurally**
  — `buildKnowledgeBlock` / `buildDirectiveBlock` return the ids that survived
  the budget trim, replacing the fragile `getRenderedEntryIds` reverse
  text-substring matcher (now deleted). No internal ids leak into the LLM prompt.

**Defect 1 — shown-set pollution (HIGH):**
- The shown-set write moved out of `readMergedKnowledge` (which only sees the
  widened ~20-id pre-rerank pool) and into the injectors, which record the
  **final rendered set** (≤ `max_inject_count`) under the canonical `Phase N`
  key. Previously every stored id received a phantom phase outcome; now only the
  actually-injected ids do.

**Defect 2 — delegate orphaning (MEDIUM):**
- Delegate injections now record under the canonical `Phase N` (resolved from
  the parent plan) instead of the raw task title, bump `shown_count`, and receive
  outcome attribution. Orphaned task-title keys are eliminated.

**Defect 3 — phase re-confirmation (MEDIUM):**
- Retrieval/injection now appends a `PhaseConfirmationRecord` (batched, reusing
  `reinforceSwarmKnowledgeEntry` so confidence stays consistent), so multi-phase
  confirmation accumulates from normal loop activity. History capped at 50
  records/entry.

**Concurrency:** the `Phase N` key in `.knowledge-shown.json` is now union-merged
(not overwritten), so concurrent architect + delegate writes within a phase do
not clobber each other.

## Out of scope

- The `phase-complete` failure-signal (hardcoded `true`) was already fixed by
  #1722 / #1715 and is merged; not re-done here.
- Semantic retrieval, real-time learning loop, skill-usage recording: later PRs
  in the 8-PR set (#1775, #1774, #1770).

## Acceptance

Unit tests pin every contract (shown-set integrity, union-merge, skip telemetry
round-trip, delegate attribution, phase confirmation confidence-consistency +
dedup + cap). The runtime acceptance criteria (live session shows
`.knowledge-shown.json` exists, `shown_count` non-zero, `confirmed_by` across 2
phases) require a live host and are the final post-merge gate.
