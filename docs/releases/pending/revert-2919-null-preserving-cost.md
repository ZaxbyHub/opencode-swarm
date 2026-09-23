# Revert PR #2919: null-preserving cost surfaces removed from main pending re-approval

## What changed

Reverts merge commit `eed4d25a3` (PR #2919, null-preserving unknown semantics for the legacy delegation_end / cost-fold surfaces) from `main`, restoring the previous zero-default behavior on all 17 files the PR touched. This is an administrative revert at the repository owner's direction: the work was merged without a merge-specific approval, and main must not carry it until that approval is given. The implementation itself remains fully intact and CI-green (45/45 at `48eb3bf27`) on branch `fix/issue-2789-null-preserving-cost` for an approval-gated re-land.

`main` returns to: `delegation_end` emitting `tokens_*: 0` when the producer holds no value; zero-default folds in `cost-accounting.ts` (`ZERO_USAGE`, `readFiniteNonNegative(...) ?? 0`); zero-filled `missing_cost` evidence usage; `/swarm costs` rendering `0` columns; `AUTO_REVIEW` cost accumulation zero-filling; and the pre-#2919 emit-line-parity golden corpus with its `e50386b9` guard pin.
