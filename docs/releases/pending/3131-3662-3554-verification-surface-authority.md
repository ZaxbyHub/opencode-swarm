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
  gate permanently red until a manual fetch). Systemic failures (abort,
  timeout, spawn failure) stop the walk after one spawn — fail-closed. When
  no candidate yields a usable base, the null now carries a named diagnostic
  (every ref tried + outcome) on the always-visible `criticalWarn` channel,
  so "all candidates unusable" is no longer indistinguishable from "git
  unavailable".

- **#3662 — session authority.** The `completion_verify` tool wrapper no
  longer falls back to the model-supplied `sessionID` argument when the
  plugin context has no session: the Turbo Mode bypass is decided only by
  `ctx?.sessionID`. A context-absent call naming a Turbo-active session now
  runs the verification (and blocks an incomplete phase) instead of
  returning `passed` with the bypass reason. The argument stays
  accepted-and-ignored with an honest description. The direct
  `executeCompletionVerify` API keeps explicit-session authority — the
  `phase_complete` gate passing its own session is intended behavior.

- **#3554 — evidence-root classification.** `/swarm doctor` stops reporting
  derived non-task subtrees under `.swarm/evidence/` as "Orphaned
  Evidence ❌". A listing-side classification (src/evidence/derived-entries.ts)
  exempts the named derived writers (`gate-audit`, `task-gate-requirements`,
  `task-gate-quarantine`, `auto-review`) and marker-gated phase-numbered
  directories (every real phase-writer artifact: SAST baseline, epic phase
  review, lean-turbo critic/reviewer + nested `lean-turbo/`, curator
  findings, completion-verify, auto-review, architecture summaries,
  drift/hallucination/mutation evidence, and the `full-auto-{seq}.json`
  grammar). A REAL task bundle — a directory containing a root-level
  `evidence.json` — always wins over every name/marker exemption, so a task
  genuinely named `gate-audit` or `9` is still enumerated. Phase-evidence
  snapshot membership is untouched (`SNAPSHOT_EXCLUDED_EVIDENCE_ENTRIES`
  stays exactly `{'receipts'}`; byte-identical snapshots pinned).

## Why

Each fix closes a verification surface taking an authoritative input from a
non-authoritative source: a stale-but-resolvable ref for a diff base, a
model-controllable argument for a session credential, or a derived-writer
directory name standing in for a plan task id.

## Verification

- 11 frozen acceptance checks (anchor
  `manifest=426c2d0da750882907dae7a5540c7dc7ee1d82e4`): C1/C2/C3/C9
  RED-at-base → GREEN at head; C6 NEW-SURFACE spec green; C4/C5/C7/C8/C10/C11
  floors green at both ends. Real-git fixtures (stale-first candidate,
  stdout-guard overflow, parser-cap overflow, overflow-then-HEAD guard,
  systemic single-spawn stop, no-debug diagnostic).
