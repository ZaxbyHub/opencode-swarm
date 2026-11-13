---
issue: 3681, 3680
---

# Verification-surface residuals: strict diff parser, pathspec parity, fall-through signal, honest doctor, no-git terminal denials

## What

Five shipped corrections from the PR #3677 / #3668 review ladders, one disclosed
pending-owner decision:

- **#3681 item 1 — diff-line parser hunk-body state.**
  `parseDiffLineRangesChecked` now arms old/new counters from each `@@`
  header and treats `--- ` / `+++ ` / `diff --git` / `@@` shapes as CONTENT
  while a hunk still owes body lines. Previously a hunk containing a deleted
  line whose text begins `-- ` (rendered `--- <content>`) and an added line
  whose text begins `++ ` (rendered `+++ <content>`) reattributed the rest of
  the hunk to a phantom file key — real changed lines vanished from the
  map and the SAST PRE-EXISTING classification silently stopped gating
  them. Under-delivery, per-side over-delivery, and unknown armed prefixes
  now fail closed (null map = no discount).
- **#3681 item 2 — pathspec parity.** `getChangedLineRanges`'s status leg
  wraps caller paths in `:(literal)` at argv construction, matching the
  ambiguity consumer's existing guard. A requested filename containing glob
  metacharacters (e.g. `app/a[b].ts`) no longer silently admits sibling
  files (`app/ab.ts`) into the changed-line map. (The issue text described
  this inverted — claiming a missing `:(top)` anchor on the ambiguity side;
  executed probes on the trace showed `:(top)` never existed and the real
  live gap is the ranges-side over-match.)
- **#3681 item 3(b) — fall-through signal.** When a diff-base candidate is
  accepted AFTER an earlier candidate produced an unusable committed diff
  (stdout overflow / parse failure), the resolver now emits a per-directory
  cooled-down CRITICAL-WARN naming `diff-base fall-through accepted`, the
  unusable-diff class, and the accepted ref (the skipped candidate is
  recorded in the resolver's attempt list rather than named in the
  message). The silent hop narrowing itself (committed changes between the
  skipped candidate and the accepted base classify PRE-EXISTING) is
  disclosed and **pending the owner adjudication tracked on #3681** —
  with no network, committed-hop authority for a HEAD-equal acceptance
  cannot be proven from workspace state (three heuristic designs were
  disproved by executed counterexamples
  during the plan review, including the push-to-main and planted-
  first-candidate geometries), and the two sound closures each carry
  their own cost: conservative fail-closed on every HEAD-equal /
  push-to-main-shaped acceptance reverses the #2918 F-002 fresh-branch
  contract, while fetch-verified base selection adds remote-tracking-ref
  mutation to a gate path. Both need a maintainer decision. **HEAD-equal
  acceptance is
  therefore still classified PRE-EXISTING today by design-pending**, exactly
  as disclosed in the #3131 release fragment; the secretscan arm keeps its
  unconditional HEAD-equal shield.
- **#3681 item 5 — honest doctor.** `/swarm diagnose`'s orphaned-evidence
  filter now recognizes the reserved fixed tool-evidence ids (single source:
  the exported `isInternalToolEvidenceId` wrapping `INTERNAL_TOOL_ID_REGEX`)
  and the synthetic `phase-<n>-summaries` buckets, so real projects no
  longer see a permanent false "Evidence for [build, syntax_check, ...] not
  in plan". Genuine orphans (e.g. a `9.9` bundle with no plan task) remain
  enumerated; the retro exemption stays broad on purpose (it matches the
  retro writer's contract) and now says so in code.
- **#3680 — no-git workspaces reach a terminal, actionable denial.**
  Reviewer dispatch in a workspace where git is permanently unavailable now
  returns `retryable=false` with typed codes `no_git_workspace`,
  `git_unavailable`, `git_dubious_ownership`, or `git_unhealthy` (corrupt
  ref/object) on BOTH the routed and the zero-routed attribution paths —
  ending the endless `head_timeout retryable=true` retry loop that could
  never self-heal. Transient causes (unborn HEAD — one commit rescues it,
  genuine timeout, oversized output) keep the retryable `head_timeout`
  behavior. The availability probe is git-native (`rev-parse --git-dir`,
  then `rev-parse --verify HEAD^{commit}` with a bounded follow-up chain
  distinguishing absent-branch unborn from corrupt refs), never a
  filesystem `.git` marker check, and every spawn is bounded per AGENTS.md
  invariant 3 with the capture deadline honored.

## Fix

- `src/tools/pre-check-batch.ts` — strict hunk-body parser state machine;
  `:(literal)` status-leg argv; `hadUnusableAttempt`/`acceptedCandidateRef`
  resolver provenance; per-directory cooled-down
  `diff-base fall-through accepted` criticalWarn; resolver docstring now
  records the authority theorem and the pending #3681 owner decision.
- `src/validation/task-id.ts`, `src/summaries/store.ts` — exported
  single-source exemption predicates.
- `src/services/diagnose-service.ts` — orphan filter consumes them.
- `src/hooks/review-receipt-scope.ts` — `classifyWorkspaceGitHealth` +
  typed `resolveHeadSha` causes; new permanent codes join
  `ReviewerScopeBuildFailureCode`.
- `src/hooks/reviewer-scope-lifecycle.ts` — routed and zero-routed dispatch
  paths classify on entry and once more after capture (the recheck), and
  terminate on permanent causes; the degraded advisory names the terminal
  condition instead of advising re-dispatch; the in-code attribution
  comment corrected (the routed head_timeout wall pre-dates PR #3668;
  the zero-routed retryable conversion was #3668's).
- `docs/configuration.md` — reviewer-gate rows document the no-git terminal
  state.

## Verified

Frozen acceptance checks C1-C14 (trace
`.agents/issue-traces/3681-3680-gate-authority-residuals/`, anchor
published pre-implementation on both issues): C1-C5, C8-C13 RED→GREEN or
GREEN→GREEN as typed; C7/C14 GREEN via this fragment and the docs rows.
C6 (push-to-main committed-CRITICAL must fail the SAST gate) is
deliberately NOT shipped green — it is the disclosed owner-decision
criterion for the HEAD-equal authority question above.
