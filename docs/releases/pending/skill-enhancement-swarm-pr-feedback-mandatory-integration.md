# Skill enhancement: swarm-pr-feedback mandatory PR comment integration

## What changed

Enhanced the canonical `swarm-pr-feedback` skill at `.opencode/skills/swarm-pr-feedback/SKILL.md` with four additions addressing real failure modes discovered during PR #1245 follow-up:

1. **CI matrix cascade check** (in Intake Surfaces) — diagnostic when downstream `integration`/`smoke` jobs are blocked by a unit matrix leg failure. Explains how to distinguish code issues from runner performance, and how to surface cascade failures to the user.

2. **PR body claim verification** (in Intake Surfaces) — verifies "council APPROVED" and similar claims against `.swarm/evidence/` files. Bot-generated PR bodies commonly auto-fill these claims without real review.

3. **Mandatory: integrate all PR comments with feedback or findings before validation** (in Feedback Ledger) — hard requirement that every PR comment with feedback or findings becomes a `FB-###` ledger item before verification begins. Defines what counts (reviewer requests, claims, bot findings, CI failures, review summaries) and what does not (acknowledgements, PR metadata). Includes status hierarchy: `CONFIRMED`/`PARTIAL` must be addressed; `DISPROVED`/`PRE_EXISTING`/`NEEDS_MORE_EVIDENCE`/`NEEDS_USER_DECISION` may remain open but must be explicitly justified.

4. **DI seam migration validation** (in Verification) — confirms consumer code reads from the seam at call time. A common anti-pattern: tests mutate `_internals.foo = mock`, but production code imports the named function which is bound at module load.

Plus a new canonical status: `NEEDS_MORE_EVIDENCE` (added to the Verification status table) for claims unsupported by stored evidence.

## Why

These four failure modes were all encountered in a single PR feedback session (PR #1245 follow-up):

- **CI matrix cascade** cost 4+ CI cycles of re-running and waiting (Windows runner hung on `tests/unit/tools/` step). The user could have been informed earlier.
- **PR body claim** — the original PR's "PHASE 2 council APPROVED" claim was unsupportable: `.swarm/evidence/` had only `agent-tools-init-*.json` files, no council verdict artifacts.
- **Mandatory integration** — silently addressing review comments without ledger items means the closure summary cannot demonstrate every comment was considered. This is the single most important change: it prevents "addressed but not recorded" findings.
- **DI seam migration** — PR #1245's `_internals` migration was incomplete because production code used static named imports. 10 of 14 dark-matter-wiring tests failed.

The mandatory integration rule prevents the recurring pattern of "I fixed it but the closure summary doesn't show I addressed every comment."

## Migration

No migration needed. The skill is invoked on-demand; agents reading the updated skill will see the new mandates automatically. Existing in-progress feedback closures do not need to be retroactively re-templated.

## Invariant audit

- 1 (plugin init): not touched — no init-path code modified
- 2 (runtime portability): not touched — no code modified
- 3 (subprocesses): not touched
- 4 (.swarm containment): not touched
- 5 (plan durability): not touched
- 6 (test_runner safety): not touched
- 7 (test writing): not touched — but the new "DI seam migration validation" sub-section improves test-writing practice by catching the seam-bound-at-import anti-pattern at PR feedback time
- 8 (session state): not touched
- 9 (guardrails/retry): not touched
- 10 (chat/system msg): not touched
- 11 (tool registration): not touched
- 12 (release/cache): touched — this fragment created; `dist/` not committed; no version files hand-edited

## Test plan

- [x] Markdown format: `bunx biome ci .opencode/skills/swarm-pr-feedback/SKILL.md` exits 0
- [x] Three mirror files unchanged: `.claude/skills/swarm-pr-feedback/SKILL.md` and `.agents/skills/swarm-pr-feedback/SKILL.md` delegate to the canonical file (no update needed — they contain adapter-specific notes, not full content)
- [x] `swarm-pr-feedback` reviewer (lowtier_reviewer) APPROVED the changes after two review rounds:
  - Round 1: CHANGES_REQUESTED (duplicate line, missing status)
  - Round 2: APPROVED with minor gap
  - Round 3: APPROVED (gap addressed)
- [x] No code paths affected: skill is documentation only, no `.ts`/`.js` source files modified
- [x] `bun run typecheck`: not run (no type-checkable code changed)
- [x] `bun run build`: not run (no source files changed)
- [x] Plugin loads: not run (entry point unchanged)
