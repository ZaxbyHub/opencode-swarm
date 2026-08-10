# Session reflection surfaces knowledge/skill/issue signals + optional action menu

## Summary

`/swarm finalize`'s session-reflection stage now surfaces the session signals it
was already computing but discarding, and presents a numbered action menu after
the destructive finalize stages complete. This is wiring + surfacing work — no
new mutation operations, no new store fields, no rebuild of the existing
memory/learning/skill-usage machinery.

## What changed

### Reflection report (Phase A — advisory compute, zero new writes)

The reflection report now includes a **Session Signals** block rendered
unconditionally (so it appears even in a clean / NOOP session), covering six
signal classes:

- **Knowledge Delta** — entries created this session, close-time curation counts
  (stored/reinforced/skipped/rejected/quarantined), realtime admission counts
  (admitted/reinforced/rejected recovered read-only from durable markers), and
  the FR-015 dedup drop count (previously dropped invisibly). Reports
  `0 lessons captured; 0 deduped as already-known.` in the clean case.
- **Skill Compliance Signals** — top skills by violation this session, read-only
  from `.swarm/skill-usage.jsonl`, scope-labeled and tail-bounded.
- **Contradiction Candidates** — sub-dedup-threshold negation-divergent
  knowledge pairs, detected (not acted on) using the existing Jaccard bigram
  primitives. Supersession is surfaced only as a menu item the user opts into.
- **Issue Candidates** — drafted GitHub issue bodies for problems backed by
  reproduction evidence (gate-fail verdicts or high tool failure rates).
- **Negatives** — explicit "0 captured" reporting (the previously-absent NOOP
  outcome).
- **Prompt fix** — `REFLECTION_SYSTEM_PROMPT`'s Skill Recommendations section now
  includes the "capturing nothing is a valid outcome" license (it previously
  existed only for Problems), reducing over-produced skill recommendations.

### Action menu (Phase B — post-lock, advisory)

After `finalize.lock` is released, the finalize output ends with a numbered
action menu assembled from the reflection proposals, each routing to an existing
tool (`/swarm curate`, `gh issue create`, `skill_improve`). Application happens
in a later user turn — no new mutation pipeline, no writes inside finalize. Under
full-auto the menu is reported-only (no "reply with numbers" prompt).

## Safety

- No new mutation ops, no new store fields.
- Contradiction detection is read-only; supersession is never automatic.
- The action menu runs after `finalize.lock` release; under full-auto it is
  reported-only.
- Realtime admission counts are recovered from durable markers (the in-memory
  `DrainSummary` is discarded at `src/index.ts` — tracked in #1821); realtime
  rejections (screened-out candidates) remain unobservable and are flagged in the
  report.

## Tests

- New `src/services/session-reflection.signals.test.ts` covers the gather
  functions, signals block, action menu, and the both-paths `signalsReport`
  invariant.
- New `tests/unit/commands/close-reflection-menu.test.ts` covers the command-level
  menu rendering (AC-3) and full-auto prompt suppression (AC-4).
- Existing `session-reflection.test.ts` unchanged (453 lines); existing
  `close.test.ts` assertion updated to distinguish the skill-compilation hint
  from the new signals-block delta line.

Closes #2077
