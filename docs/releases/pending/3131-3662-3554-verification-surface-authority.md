---
issue: 3131, 3662, 3554
---

# Verification-surface authority: merge-base fall-through, session-bound Turbo bypass, derived-evidence classification

## What

Three verification-surface correctness fixes, one per issue:

- **#3131 — diff-base authority.** `getChangedLineRanges` (and
  `getChangedLineAmbiguousFiles`) no longer accept the FIRST merge-base
  candidate that merely resolves. Both walk `zaxbyhub/main → upstream/main →
  origin/main → main → origin/master → master` through one shared validated
  resolver: a candidate is only accepted when its committed diff can be
  acquired AND parsed. A stale-but-resolvable ref whose diff trips the 2 MB
  stdout guard or the 200k-line parser cap falls through to the next
  candidate instead of silently nulling the changed-line map (the live
  #3092 incident: a stale `zaxbyhub/main` made the diff-scoped secretscan
  gate permanently red until a manual fetch). A merge-base equal to HEAD is
  accepted but FLAGGED non-authoritative (#3092 PRR-002): the ambiguity set
  keeps its original refusal, and the changed-line map fails closed with a
  named diagnostic WHEN the HEAD-equal base was reached by falling through
  a candidate that failed validation (overflow/planted-ref signature — the
  4.5 review caught the ranges consumer treating the empty committed map as
  authoritative there, failing the SAST gate OPEN). A FIRST-resolvable
  HEAD-equal base keeps the staged/unstaged/untracked map exactly as at
  base (the #2918 F-002 ignored-file contract). That residual acceptance is
  a disclosed trade-off, not a clean pass: when the first resolvable
  candidate is HEAD-equal — a fresh branch with no commits past its base,
  but equally a repo with no remote where you commit on `main`, or a
  push-to-main checkout where `origin/main == HEAD` — the committed hop is
  empty, so the SAST arm classifies committed changes as PRE-EXISTING
  (advisory: the gate passes; the source comment at the classify call site
  discloses the asymmetry). This PR does not change that geometry
  (byte-identical at base — not a regression); closing it needs
  fetch-verified/remote-preferring base resolution and is tracked as a
  follow-up. Abort, timeout,
  and spawn failures without output-guard flags stop the walk after one
  spawn (executable-resolution and HEAD-resolution failures each carry their
  own named cause); an output-guard termination (reported by the runner as
  spawn-error WITH truncation flags) is treated as candidate-unusable and
  falls through, bounded by the candidate list — every terminal path is
  fail-closed. When no candidate yields a usable base, the null carries a
  named diagnostic (every ref tried + outcome, or the pre-walk failure
  cause) on the always-visible `criticalWarn` channel, so "all candidates
  unusable" is no longer indistinguishable from "git unavailable".

- **#3662 — session authority.** The `completion_verify` tool wrapper no
  longer falls back to the model-supplied `sessionID` argument when the
  plugin context has no session: the Turbo Mode bypass is decided only by
  `ctx?.sessionID`. A context-absent call naming a Turbo-active session now
  runs the verification (and blocks an incomplete phase) instead of
  returning `passed` with the bypass reason. The argument stays
  accepted-and-ignored with an honest description. The direct
  `executeCompletionVerify` API keeps explicit-session authority. The
  sibling `phase_complete` gate still reads `ctx?.sessionID ??
  args.sessionID` (unchanged, pre-existing — a context-absent call naming a
  Turbo-active session bypasses its completion_verify gate there); that
  class is tracked for owner adjudication in #3675.

- **#3554 — evidence-root classification.** `/swarm doctor` stops reporting
  derived non-task subtrees under `.swarm/evidence/` as "Orphaned
  Evidence ❌" for the classified writer population. A listing-side
  classification (src/evidence/derived-entries.ts)
  exempts the named derived writers (`gate-audit`, `task-gate-requirements`,
  `task-gate-quarantine`, `auto-review`, `sbom`) and marker-gated
  phase-numbered directories (the verified phase-writer artifacts: SAST
  baseline, epic phase review, lean-turbo critic/reviewer + nested
  `lean-turbo/`, curator findings, completion-verify, phase-council
  (opt-in), auto-review, architecture summaries,
  drift/hallucination/mutation evidence, and the `full-auto-{seq}.json`
  grammar). A REAL task bundle — a directory containing a root-level
  `evidence.json` — always wins over every name/marker exemption, so a task
  genuinely named `gate-audit` or `9` is still enumerated. Two disclosed
  residuals remain out of scope: (a) the doctor's orphan filter (not the
  listing classifier) still reports the fixed-id tool-evidence bundles
  (`build`, `syntax_check`, `secretscan`, …) that legitimately carry a root
  `evidence.json` — fixing that belongs in the doctor filter, not the
  classifier, and is tracked as a follow-up; (b) phase-evidence
  snapshot membership is untouched (`SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES`
  stays exactly `{'receipts'}`; byte-identical snapshots pinned).

## Why

Each fix closes a verification surface taking an authoritative input from a
non-authoritative source: a stale-but-resolvable ref for a diff base, a
model-controllable argument for a session credential, or a derived-writer
directory name standing in for a plan task id.

## Verification

- 11 frozen acceptance checks (anchor
  `manifest=84fe56a7908c6343e340af4548dc7af1c889c754`): C1/C2/C3/C9
  RED-at-base → GREEN at head; C6 NEW-SURFACE spec green; C4/C5/C7/C8/C10/C11
  floors green at both ends. Real-git fixtures (stale-first candidate,
  stdout-guard overflow, parser-cap overflow, overflow-then-HEAD guard,
  systemic single-spawn stop, no-debug diagnostic).
