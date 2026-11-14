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


- **#3681 item 1 (rounds 13-18) — git-configuration output shapes.** The
  strict parser is only as safe as the shape git actually renders, and four
  repository-configuration families changed that shape without changing the
  content. A text file marked `-diff` or `binary` in `.gitattributes` renders as
  `Binary files X and Y differ` with no hunk at all, so the file never entered
  the changed-line map and `classifySastFindings` treated the missing key as
  PRE-EXISTING — a newly added dangerous line kept its discount; such a file
  is now marked `ALL_LINES_CHANGED`, with its path normalized exactly as the
  `+++ ` branch normalizes its own (a mixed-case path, a path containing
  ` and `, and a path with a leading space each failed open before that). A
  `diff.<driver>.textconv` filter and a `filter=<driver>` clean/process filter
  both make git diff a TRANSFORMED representation while SAST scans the
  worktree one, so hunk coordinates pointed at text the scanner never saw;
  `--no-textconv` is now pinned beside `--no-ext-diff` on the three
  patch-producing argv sites, and a `git check-attr --all -z` leg marks any
  changed file carrying a configured filter `ALL_LINES_CHANGED`. The leg
  queries the RAW repo-relative spellings git emitted rather than the
  case-folded map keys (a lowercased query misses a mixed-case rule whenever
  `core.ignoreCase` is false), records every spelling that maps to one key
  rather than the last one written, strips the trailing TAB `git diff` appends
  to an unquoted `+++ ` header for a space-bearing filename, covers the
  committed hop as well as the staged/unstaged/untracked legs, and chunks its
  argv by accumulated LENGTH so a very large changeset cannot exceed the
  Windows 32767-character command-line limit. `--all` rather than
  `check-attr filter <attr>` because the latter always emits a record (value
  `unspecified` when unset) and git permits — and executes — a driver
  literally named `unspecified`, `unset` or `set`, so neither the record's
  existence nor its value can be read as "the attribute is absent". A copied
  file under `diff.renames=copies` emits only `copy from`/`copy to` with no
  hunk and its destination left the map entirely; it is now gated. And a
  `+++ ` destination the `diff --git` header did not name, or a non-empty diff
  containing no git file section at all, now fails closed instead of
  producing an authoritative map.

  Disclosed over-gating, not closed here: the leg marks a file
  `ALL_LINES_CHANGED` whenever `check-attr --all` reports a `filter`
  record, and two shapes lose the PRE-EXISTING discount they could
  legitimately keep — an explicit `-filter` opt-out (a common LFS
  exception, which git reports as `filter unset`) and a bare `filter`
  (git reports `filter set`). Neither can be filtered out by value,
  because git permits and executes a driver literally named `unset` or
  `set`. Narrowing them needs effective-config detection first and is
  recorded as a future IMPROVEMENT, not a correctness fix.

  THREE FURTHER SHAPES ARE CORRECTNESS-REQUIRED, NOT OVER-GATING.
  A `filter=<driver>` with an effective `smudge` but no `clean` or `process`
  shifts coordinates exactly the way LFS does: git skips the clean step,
  so the committed blob is the source text while the scanner reads the
  SMUDGED worktree (executed: a 3-line committed blob against a 4-line
  worktree file, so a committed-new line 4 falls outside the union and
  would classify PRE-EXISTING if the gate were removed). Active LFS is
  the same mechanism — `filter.lfs.clean` writes a pointer blob, so a
  10-line worktree file yields a 3-line HEAD blob and `@@ -2,2 +2,2 @@`,
  and a source-line-9 finding has no corresponding pointer coordinate
  (executed with git-lfs 3.7.1). A driver with NEITHER an effective
  `clean`, `process` nor `smudge` is genuine pass-through (executed:
  `@@ -3 +3 @@` unchanged).
  Two pre-existing shapes in the same class are deliberately NOT closed here
  and are filed as one collated follow-up: a nested independent project root
  that carries `.opencode/` but no `.git` of its own still gets
  repository-root-relative map keys while the classifier computes
  project-directory-relative paths, and the parser still does not validate
  the `diff --git` paths against `--- `/`+++ ` for every shape.
## Fix

- `src/tools/pre-check-batch.ts` — strict hunk-body parser state machine;
  `:(literal)` status-leg argv; `hadUnusableAttempt`/`acceptedCandidateRef`
  resolver provenance; per-directory cooled-down
  `diff-base fall-through accepted` criticalWarn; resolver docstring now
  records the authority theorem and the pending #3681 owner decision;
  `git-configuration` output-shape handling (`Binary files` sections,
  copy/rename destinations, the phantom-destination and no-section
  fail-closes, `--no-textconv` argv pins, and the `check-attr --all -z`
  filter leg with its raw-path collector, TAB-stripped header spellings,
  committed-hop coverage and length-bounded argv chunking).
- `src/validation/task-id.ts`, `src/summaries/store.ts` — exported
  single-source exemption predicates.
- `src/services/diagnose-service.ts` — orphan filter consumes them.
- `src/hooks/review-receipt-scope.ts` — `classifyWorkspaceGitHealth` +
  typed `resolveHeadSha` causes; new permanent codes join
  `ReviewerScopeBuildFailureCode`.
- `src/hooks/reviewer-scope-lifecycle.ts` — the zero-routed denial and
  degraded-advisory paths classify on entry and terminate on permanent
  causes; the routed capture in `review-receipt-scope.ts` classifies on
  entry and once more after capture (the recheck); the degraded advisory
  names the terminal condition instead of advising re-dispatch; the in-code
  attribution comment corrected (the routed head_timeout wall pre-dates
  PR #3668; the zero-routed retryable conversion was #3668's).
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
