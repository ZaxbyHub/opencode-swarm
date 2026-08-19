fix(tools): export MAX_LANES and drift-check prose citations of the lane cap

## What changed

- `src/tools/dispatch-lanes.ts`: `MAX_LANES` (the dispatch_lanes batch cap, value 8) is now exported, matching its neighbor `MAX_PROMPT_CHARS`. No runtime behavior change — `.max(MAX_LANES)` schemas and clamp logic are untouched.
- `scripts/drift-check-docs-claims.ts` (the `docs-claim` detector behind `bun run drift:check`): now also imports the exported `MAX_LANES` and regex-checks every hand-copied prose citation of the lane batch cap against it. Covered surfaces:
  - pinned skill/docs prose: `.opencode/skills/pre-phase-briefing/SKILL.md`, its `.claude/skills/pre-phase-briefing/SKILL.md` mirror, `.opencode/skills/swarm-pr-review/SKILL.md` (both the base-lane and micro-lane sentences, including the spelled-out "eight lanes" form), `.opencode/skills/swarm-pr-feedback/SKILL.md` (batch cap and sequential-batch threshold), `.opencode/skills/codebase-review-swarm/references/review-protocol-v8.2.md`, and `docs/architecture.md`;
  - every pending release fragment under `docs/releases/pending/` (transient files, so scanned as a directory rather than pinned by path; shipped `docs/releases/<version>/` notes are frozen history and never checked).
- Mismatches surface as the existing soft-warn behavior: GitHub Actions annotations plus the drift report, exit 0 unless `DRIFT_CHECK_ENFORCE=1` is set.
- `tests/unit/scripts/drift-check.test.ts`: regression tests with deliberately-mismatched fixtures (digit form, spelled-out "eight", `.claude` mirror, pending fragment, two-wrong-numbers double finding, missing-file error, absent-pending-dir non-drift).
- `docs/engineering-invariants.md`: `docs-claim` row and bullet updated to describe the new coverage.

## Why

`MAX_LANES` was unexported while `MAX_PROMPT_CHARS` on the next line is exported — an oversight, not a policy. Four-plus prose locations hand-copy the number "8"; if the constant ever changes, those copies silently drift with no build-time signal (issue #1645, enhancement audit Track G / ENH-G002-6). The detector extension follows the existing docs-claim pattern (import the real constant, compare against prose) so drift-check stays grep-free.

## Migration steps

None. Run `bun run drift:check` as usual; the new checks are part of it. If a lane-cap prose citation is flagged, update the prose to match `MAX_LANES` (or, when intentionally changing the cap, update the constant and all cited prose in the same commit — the detector findings list every drifted copy).

## Known caveats

- The detector recognizes the specific phrasings currently in the tree ("dispatch cap of N lanes per batch", "accepts a maximum of N lanes per call", "accepts at most eight|N lanes per call", "batch at N lanes (`MAX_LANES`)", "needs more than N verification lanes", "scaled toward the N-lane dispatch limit", "up to the N-lane cap", plus generic `MAX_LANES=N`, "N lanes per call/batch", "N-lane cap/limit" in fragments). A future citation written in a novel phrasing is not detected until a regex is added — the pinned-entry "missing numeric claim" warning is the backstop for reworded pinned sentences.
- Soft-warn by default, like the rest of drift-check: annotations only, unless the repo variable `DRIFT_CHECK_ENFORCE=1` is set.
- The 8-lane cap remains non-configurable by design (separate policy decision, per the issue).
