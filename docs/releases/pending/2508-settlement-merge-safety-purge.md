# Settlement merge safety and two-step destructive purge (issue #2508)

## What changed

- **Typed overlap diagnostic on settlement merge-back.** When lane settlement blocks because the user has local changes overlapping files the lane modified, the partial settlement result and the `STANDARD_WORKTREE_MERGE_PARTIAL` advisory now carry a stable machine-readable code (`SETTLEMENT_OVERLAP_BLOCKED`) and an imperative recovery hint (commit or stash the overlapping paths, or recover the preserved lane), in the repository's ACTION[...] house style. The fail-closed gate itself is unchanged — path-level overlap blocking already preserved the lane.
- **Squash-merge-unstaged settlement landing (default).** A `'merge'`-strategy worktree-lane settlement now lands the lane's changes as UNSTAGED, reviewable working-tree modifications instead of an automatic merge commit: `git merge --squash --no-commit` followed by a targeted `git reset` scoped to the lane's incoming paths (both sides of renames; the user's unrelated staged entries are preserved). The lane branch is retained as the recovery backup for the unstaged bytes until the user commits; the existing orphaned-branch lifecycle reclaims it later. Provenance and the settlement WAL still record the passed dispatch strategy — no persisted enum ever sees the new internal landing value. Lean Turbo merge-back explicitly opts into the committed landing (`commitLanding`) and is unchanged. Design ideas (squash-unstaged settlement shape, overlap blocking with typed diagnostics, two-step purge) reimplemented per ADR 0002 with credit to opencode-ensemble; no upstream code ported.
- **Durable lane-branch retention.** The squash-unstaged landing stamps `landedUnstaged` on the settlement WAL's worktree descriptor, and every later cleanup pass (`completeCoderSettlementCleanup`, recovery scans, crash resume) retains the lane branch from that durable stamp instead of deleting it as residue. The retention guarantee now survives process restarts and the post-settlement cleanup chain, not just the in-process merge call site.
- **Crash-window settlement recovery self-heals (#2682 review).** If a process crashed between a squash-unstaged landing and its WAL write, recovery re-derived the merge from the retained lane branch, misread the landing's own unstaged bytes as user work, and wedged with `SETTLEMENT_OVERLAP_BLOCKED`. Merge reconciliation now detects an already-landed squash landing by working-tree content identity (`worktree-match`): every incoming path must match the lane head byte-for-byte, any divergence keeps the fail-closed block, and the reconciled settlement stamps the durable branch-retention marker.
- **Scope-digest separator hardening.** Purge-candidate paths containing NUL or newline characters are now rejected before the confirm-token scope digest is computed, instead of producing an ambiguous hash input (POSIX permits both in filenames).

- **Close gate fails closed on unreadable git status.** If `git status` cannot be read in a real repository (spawn failure, timeout, or nonzero exit), `/swarm close` refuses to run the destructive pipeline ("fail-closed" advisory) rather than treating the tree as clean; nothing is closed, archived, or destroyed until git is readable again. A bare `.git` marker directory (an accepted #2127 project root with no repository behind it) carries no git-tracked work and does not trip the gate. Preview porcelain renames list both sides of `R old -> new`, and the confirm token's scope digest is bound to the `swarm-close` kind, so a token minted by one destructive surface cannot be consumed by another with the same paths.
- **Two-step destructive purge for `/swarm close`.** When the destructive portion of close would destroy unconsumed user work (tracked uncommitted changes that git alignment discards), a no-token `/swarm close` now returns a side-effect-free preview — counts, the exact option label with a real one-shot confirm token (15-minute TTL, scope-digest bound) — and destroys nothing. Executing requires `--confirm=<token>`. Wrong/replayed/expired tokens and changed scopes are rejected with nothing destroyed. On a clean tree (or non-git project) close keeps its previous single-call behavior, mirroring `/swarm reset-session`'s #2527 pattern; the shared confirmation primitive (`src/commands/destructive-purge.ts`) gains `consumeConfirmToken` and close adopts it rather than a second primitive.

## Why

Issue #2508 (Workstream G4): lane work must never silently overwrite user-modified files, and destructive swarm operations require preview + confirm-token. The old settlement committed merges over the user's HEAD with nothing reviewable, and close's align stage silently discarded uncommitted user work (`git reset --hard`) with no preview or confirmation.

## Migration

- Default landing shape change: dispatch strategy `'merge'` (the config default) now lands unstaged instead of a committed merge. `'rebase'` and `'cherry-pick'` still land committed. Teams wanting the old committed merge from automation consuming `/swarm close` output are unaffected on clean trees (no preview fires).
- In-flight settlements created before the upgrade resume cleanly afterwards: provenance identity still matches the passed `'merge'` strategy, and a resumed settlement replays through the new landing shape fail-closed.

## Caveats

- The close preview is conditional (fires only when tracked uncommitted work would be destroyed) — a deliberate deviation from the issue's literal "first call returns a preview" following the #2527 escalate-only-on-destruction precedent. Untracked files never trigger it (alignment does not discard them); gitignored build artifacts removed by alignment's allowlisted clean pass are likewise not previewed.
- `reset-session` behavior is unchanged (delivered by #2527); this change only closes the coverage gap on `/swarm close`.

## Review closure

The merged implementation also hardens the review surfaces around this flow: branch
pruning remains explicitly opt-in, retained-lane cleanup is guarded by durable
settlement evidence, and purge scope/digest checks remain fail-closed across
restart and replay boundaries.
