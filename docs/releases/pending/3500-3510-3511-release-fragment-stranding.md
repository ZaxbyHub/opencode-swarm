---
issue: 3500
---

# Release-fragment pipeline stranding repaired: materialized v7.199.2/v7.200.1, alarm wiring, consumption-aware pins

## What changed

- **#3500** — Separator-aware provenance: published-block reconstruction now segments the separator-split parts completely (a fragment whose own content contains internal blank-line `---` horizontal rules spans multiple consecutive parts), with ambiguity, parts, and work caps all failing closed. Archived-claim resolution: a candidate PR's fragment already consumed by an earlier materialization resolves as a claim-only entry validated against the merged manifest (distinct-digest conflicts fail closed) instead of stranding the run. Empty published bodies materialize as zero-consumption (empty `v7.199.2.md`, `fragments: []`, no deletions — an empty body published nothing). The previously stranded **v7.199.2 and v7.200.1 releases are now materialized** in-repo (`docs/releases/vX.md` + manifests, `releaseBodySha256` equal to the live release body), and five byte-matched consumed fragments were deleted from `docs/releases/pending/` (including the separator-poisoned `transient-retry-subprocess-hardening.md` and `git-status-async-diagnosable.md`). A published block that references an already-archived fragment still fails closed (duplicate-consumption hazard) — now with the archived path named in the error.
- **#3510** — `release-health-summary` now needs `update-release-notes` and alarms when it fails; a skipped cleanup no longer reads as success, so a stranding release fails visibly the same day instead of surfacing in closeout archaeology.
- **#3511** — The `ensemble-adr-2505`, `cross-surface-contract`, and `ci-2552-fragments-closed-state` suites now resolve their pending-fragment pins consumption-aware (pending is the sole authority while present; once consumed, the materialized `docs/releases/v*.md` history carries the obligation; exclusive arms, never union), with fail-closed strength legs. The ci-2552 negative claims-scan applies to pending text only — the consumed-state obligation is the positive citation pin.

## Why

Two published releases (v7.199.2, v7.200.1) had zero in-repo release history and both cleanup runs died in `update-release-notes` with `incomplete release provenance`; the designated alarm stayed green on both. Three suites would have stranded the NEXT materialization the same way PR #3496 was stranded for two days.

## Verification

Ten frozen acceptance checks (anchor receipt on issue #3500): seven RED→GREEN at head (separator resolution, archived-claim resolution, live materialize replay of both tags with `releaseBodySha256` verified against the live GitHub release bodies, summary alarm, three consumption legs) and three GREEN→GREEN floors (retention/cleanup suites, workflow contract, sibling consumption-aware suites). New `release-notes-fragments-archived-replay` suite covers claim validation, conflict fail-closed, live-path skip semantics, empty-body materialization, and the segmentation bounds (ambiguity stop, parts cap, work budget).
