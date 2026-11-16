# Operational Reference

## DI seam migration validation (when the repository uses this pattern)

`_internals` and `mock.module()` below are JavaScript/TypeScript examples only.
For another stack, apply the same live-binding question using that language and
test runner's dependency-injection/mocking semantics.

When a test file mutates a DI seam object (e.g., `_internals.foo = mock`),
verify that the production source reads from the seam at call time. A common
anti-pattern: the test mutates the seam object, but the production code
imports the named function (`import { foo } from './module'`) which is bound
at module load. The seam mutation has no effect on the named reference,
so the test fails even though the seam object's `foo === mock`.

Verification: open the source file and grep for call sites. If you see
`import { foo } from '...'` followed by `foo(...)` in the production code,
and the test does `_internals.foo = mock`, the test will fail. The fix is
to change the production code to call `_internals.foo(...)` (or equivalent
active-seam pattern) so the seam mutation is read at call time.

If only a few call sites exist, fix them in the source. If many call sites
exist, consider whether the migration should use `mock.module()` instead,
which replaces the entire module object (including the named export
reference).

## Conditional runtime/host gotchas

Apply each item below only when the named plugin tool, plan model, shell, or
code-host client is actually present. They are portability examples, not
requirements imposed on unrelated repositories.

 - **Plan identity change:** When switching from a review plan to a feedback-closure
   plan, `save_plan` rejects with `PLAN_IDENTITY_MISMATCH`. Pass
   `confirm_identity_change: true` to acknowledge the intentional overwrite.
 - **Stale gate evidence:** After a plan identity change, `check_gate_status` returns
   timestamps from the *prior* plan. Reset task statuses and re-run Stage A gates
   before trusting gate results. Do not accept cached gate verdicts from before the
   identity change.
 - **PowerShell PR comment posting:** Complex markdown bodies containing backticks,
   dollar signs, or nested quotes fail in PowerShell here-strings. Write the body
   to a temp file and use `gh pr comment <number> --body-file <tempfile>` instead
   of inline `--body "..."`.
 - **Same-file batching:** Multiple findings targeting the same file for the same
   review cycle CAN be fixed in one coder task when the fixes are trivially
   independent (e.g., a one-line guard and a typo fix). When findings require
   different fixes on different code paths, use separate coder tasks even if
   targeting the same file. The "ONE task per coder" rule is about distinct
   objectives, not about N edits to one file.

## Contract addendum (2026-10-12)

- **Body-claim audit.** Before the reviewer gate, grep the LIVE published
  artifact (PR body, issue body) against every ledger row whose fix-ref is that
  artifact: the fixed phrasing present, the contradicting phrasing absent. A
  row marked FIXED for a file never edited is an unbacked claim — record
  CLOSED only after the grep matches.
- **Probe hygiene.** Mutation/revert probes must leave the tree as found:
  restore with `git checkout -- <file>` after every probe and verify
  `git status --porcelain` clean before the first commit of the round. An
  uncommitted mutant left in a tracked source file can ride explicit-path
  staging into the fix commit — or `git add -A` into the release.
  Additional precondition (recurred on the PR #3592 round): a checkout-
  restoring probe run while fix work is UNCOMMITTED silently reverts that
  work and then reads clean — commit the fix BEFORE the first probe, or give
  the probe script an entry-state guard that refuses a dirty tree
  (`git status --porcelain --untracked-files=no` must be empty). The
  issue-tracer acceptance-check contract carries the same rule with the
  attributed-kill requirements.
- **Stable obligation identity + coverage-diff.** Never substitute the
  obligation between ledger and proof: if the ledger defined mutant M4 as X,
  closing it with a different mutant Y is a new row, not a closure.
  Coverage-diff the ledger against EVERY source finding table by ID, both
  directions, before implementing.
