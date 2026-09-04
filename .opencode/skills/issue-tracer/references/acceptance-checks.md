# Acceptance Checks and the Red Checkpoint

Use this reference for Phase 2.5 (freezing the checks) and Phase 4 (proving they flip). The loop replaces ritual TDD with acceptance-test-driven development: every acceptance criterion becomes an executable check, proven to fail on the pre-fix tree for the right reason, frozen before any fix code exists, and independently replayed by the plan critic and the implementation reviewer. Method grounding is cited by title/URL in `references/method-provenance.md`; treat reported figures as reported, not re-derived.

## The loop

1. For every numbered acceptance criterion (`ACn`) in `01-issue-summary.md`, write exactly one row in the `## Acceptance checks` table appended to `02-reproduction.md` (see `references/evidence-artifacts.md` for the exact header and column set).
2. Run the executable classes against the pre-fix tree with `repro-check.sh run`. A DISCRIMINATING check that also passes on the buggy tree is vacuous and rejected - it carries no information about whether the bug is fixed (the bug-contrast replay rule below).
3. Freeze the check set with `repro-check.sh checkpoint` before any production fix code exists. The checkpoint tree-id must differ from the Phase 0 tree-id only by paths listed in `repro/checkpoint.manifest` - this is validated mechanically at `trace-check.sh phase 2.5`.
4. Phase 4 re-runs every check against the fixed tree; results are appended to the same table's `post-fix` column and echoed in `08-test-results.md`.

## The three executable classes, plus NON-EXECUTABLE

- **DISCRIMINATING** - behavior the bug breaks. Must be RED on the pre-fix tree for the expected reason (base exit nonzero and output matching `--expect`), GREEN after the fix. This is the class the bug-contrast replay rule applies to hardest.
- **PRESERVING** - behavior that must not change: compatibility, safety negatives, existing callers named by the impact analysis. Must be GREEN before and stay GREEN after.
- **NEW-SURFACE** - the check exercises a symbol, file, or script that does not exist at base, so a RED result is impossible by construction; the base run is an expected ERROR instead. Evidence is GREEN on the fixed tree plus a mandatory Phase 4.5 revert/mutation probe on the new code. A NEW-SURFACE row can never be satisfied by a rule-out - it always needs the probe.
- **NON-EXECUTABLE** - closed reason enum only: `DOCS_ONLY`, `HOST_ONLY`, `PRODUCT_DECISION`, `EXTERNAL_SERVICE_UNAVAILABLE`. Each requires named substitute evidence (a captured manual procedure, a doc diff, or a dry-run transcript) in the `notes` column, and is forbidden whenever an isolated fixture or synthetic instance could make the criterion executable instead. Nondeterministic behavior (flaky timing, races) gets a synthetic-instance DISCRIMINATING check - never a NON-EXECUTABLE row. The plan critic approves every NON-EXECUTABLE row individually before APPROVE.

## Bug-contrast replay

A DISCRIMINATING check only counts once `repro-check.sh run` has shown it failing on the pre-fix tree for the expected reason (`--expect` regex match on the base log). A check that passes on both the buggy and the fixed tree proves nothing about the bug and is rejected - this is the load-bearing finding behind this whole loop: a meaningful share of "test passed" validation events in agentic repair carry no information because the check also passes on unfixed code, and replaying checks against the pre-fix state is what catches it (see `references/method-provenance.md`). A PRESERVING check counts only after it is shown GREEN on the pre-fix tree - a PRESERVING row that is RED at base is not proving preservation, it is a mislabeled DISCRIMINATING row.

## Test-author context (roles only)

Research measured that an agent's own generated tests overfit toward validating that same agent's own patches. Where subagent dispatch is available, use a fresh, independent context to author the checks: it receives the issue summary and the root cause, never a candidate fix, and hands back checks the implementer later receives as a frozen spec it cannot edit. A different model family is preferred where the runner's routing allows one, because a same-family fresh context reduces but does not eliminate the overfitting risk the research measured - this stays a role/tier description, never a named vendor or model. Without dispatch, the orchestrator authors and freezes the checks itself, and the plan critic independently replays them before APPROVE; that limitation is disclosed in `06-critic-review.md` and the final response.

## Red checkpoint manifest and amendment procedure

`repro/checkpoint.manifest` is append-only, lives in the git-excluded trace directory, and is written only by `repro-check.sh checkpoint`/`--verify-checkpoint` (see the format in `references/phase-0-setup.md`'s sibling identities section and the script interface itself). Each line records path, blob id, mode, check id, argv, expected regex, base SHA, and a reason field. Files are formatted with the repo's own formatter before hashing, and new checks live in their own new files (never appended to an existing file already at the 500-line test-file cap) so a later formatter pass does not silently change a frozen blob.

Amending a frozen check (the check was wrong, or a formatter-only touch changed its blob) appends a new manifest entry rather than editing the old one, with a closed reason: `CHECK_WRONG`, `FORMAT_ONLY`, or `AC_CHANGED_BY_USER`. `CHECK_WRONG` and `AC_CHANGED_BY_USER` require a fresh RED/GREEN replay before the amendment counts; `FORMAT_ONLY` does not change behavior and skips the replay. The plan critic (before implementation) or the implementation reviewer (after) approves every amendment. Deleting or weakening a check to reach green, instead of amending it with a recorded reason, is a Full-Resolution Contract anti-tampering violation (clause 8).

## Dependency strategy

`repro-check.sh run` defaults to `--deps link`: if the repo root has `node_modules` (or the equivalent) and the temporary worktree does not, it is linked in rather than reinstalled, so checks run fast and against the same dependency tree as the rest of the session. `--deps none` skips this for checks with no such dependency. Never use a live install inside the throwaway worktree for a check that is expected to run repeatedly during Phase 2.5/4/4.5 iteration - that reintroduces the cost the link mode avoids.

## Characterization tests

When the fix touches a code path with no existing test coverage and the change puts existing behavior at regression risk, pin the current behavior with a PRESERVING characterization test before writing the fix - this is a stronger commitment than the general "PRESERVING" class, because its whole purpose is guarding against your own change rather than a pre-existing caller.

## Ranking-after-critic-replay rule

Multi-candidate patch trials (Phase 3, "may" for close calls) rank candidates by which acceptance checks they green, then by minimality - but only after the plan critic has independently replayed the frozen checks. Ranking candidates by self-authored checks before that replay reintroduces exactly the same-agent overfitting risk the separate test-author context exists to avoid.

## Tautology and revert/mutation probe recipes

A tautology check is one that passes regardless of the underlying logic (e.g. asserting a call happened without asserting its result, or asserting a mocked stub's own return value). Scan for these during Phase 4.5: does the check fail if the fix line is reverted? Does it fail if a single boundary condition in the fix is mutated (flip a comparison operator, invert a boolean, off-by-one an index)? A check that survives its own revert/mutation probe unchanged is a tautology and must be rewritten before it can satisfy any class, DISCRIMINATING or NEW-SURFACE.

Minimal recipe: `git stash` the fix hunk (or apply the inverse patch) in the throwaway worktree, re-run the check with `repro-check.sh run` against that reverted tree, and confirm it goes RED; restore the fix and confirm GREEN again. For NEW-SURFACE rows this probe is mandatory, not optional, because the base run can never independently demonstrate discrimination.

## Tier scaling

- **Tier S**: separate check-author context is optional; the revert/mutation probe is optional unless a NEW-SURFACE row or a risk trigger is present.
- **Tier M/L**: a separate check-author context is required when subagent dispatch is available, and the revert/mutation probe is required for every DISCRIMINATING check at tier L, and for any check touching a risk-trigger surface at tier M.

## When the path does not apply

Some issues (pure documentation fixes, non-executable product decisions already resolved by classification) have no meaningful acceptance check at all. Use NON-EXECUTABLE rows with named substitute evidence rather than forcing an artificial executable check, and let the plan critic confirm the justification is real rather than a shortcut around the loop.
