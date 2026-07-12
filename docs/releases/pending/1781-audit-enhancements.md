# Audit 2026-07-09 enhancements: test-cap ratchet, /swarm status escalation, drift:fix, tool-registration reverse guard

Issue: #1781

## What

Four CI/DX/observability enhancements surfaced by the full-repo audit of `main` @ `8822ffc9` and shipped together (no hot-path runtime behavior change):

### E1 — 500-line test-file cap is now CI-enforced (FR-006)
`scripts/check-test-file-cap.sh` is a new diff-scoped ratchet (mirrors `check-mock-cleanup.sh` / `check-test-clock.sh`) wired into the `ci.yml` quality job. It fails when a PR adds a test file over 500 lines or grows an already-over-cap file. Pre-existing over-cap files are non-blocking, so the 518 existing violators don't block unrelated PRs. CRLF is normalized before the line-count comparison; renames are treated as new files when their content changed. Escape hatch: `TEST_CAP_ENFORCE=0` soft-warns for a deliberate growth PR.

`TESTING.md`, `contributing.md`, and the `writing-tests` / `test-file-split` skill docs previously claimed the cap was either "enforced by convention, not CI" or (falsely) already CI-enforced. Both are now accurate.

### E2 — `/swarm status` surfaces full-auto oversight-escalation detail
When Full-Auto is active, `/swarm status` now shows the latest escalation reason, interaction/deadlock counts, and phase — read from a new `lastEscalation` field on `FullAutoRunState` (persisted atomically to `.swarm/full-auto-state.json` at escalation time). The render was also hoisted out of the turbo-only branch so Full-Auto status is visible even when Full-Auto runs without turbo (previously it was invisible in that common case — a pre-existing bug fixed as part of this work).

### E3 — `drift:fix` eliminates the dual-tree byte-identical edit burden
`bun run drift:fix` (`scripts/drift-check.ts --fix --confirm`) copies the canonical side to each mirror for every byte-identical mirrored skill pair, then re-verifies. Canonical-side is now encoded per pair (`canonical: '.opencode' | '.claude'`) on `MIRRORED_ARCHITECT_MODE_SKILLS` and honored by the fixer — so `commit-pr` (canonical `.claude` per `pr-standards.yml`) is copied in the correct direction. The fixer is env-guarded (`SWARM_SKILL_SYNC_CONFIRM=1` or `--confirm`), refuses to run under `DRIFT_CHECK_ENFORCE`, and never runs at plugin runtime (AGENTS.md invariant 4 amended with an explicit developer-tool exception). Also fixes a pre-existing duplicate `swarm` slug in `ADDITIONAL_SKILL_MIRROR_CONTRACTS`.

### E4 — Tool-registration reverse-direction guard + dead-code removal
`scripts/check-tool-registration.ts` now enumerates every exported `createSwarmTool(...)` binding in `src/tools/**` and fails when one has no `TOOL_METADATA` entry (or a co-located `@tool-opt-out <reason>` JSDoc tag). The two-pass binding resolver handles multi-line type annotations and the legitimate camelCase-export → snake_case-registration alias pattern. This closes the reverse gap that let `knowledge_ack` ship as a fully-built, fully-tested, but never-registered tool.

Resolved dead code:
- **`knowledge_ack`** deleted (file + test). The tool was "retired" in favor of `knowledge_receipt` (#1323) but the source + test were never removed; the pending `summarizer-threshold...` release-notes fragment is revised to reflect the deletion.
- **`src/output/agent-writer.ts`** + its barrel + test deleted. Zero production importers; the CHANGELOG claim about its functions was never wired up. (CHANGELOG is not hand-edited per invariant 12; the stale claim self-heals via this fragment.)

## Why
The audit surfaced a recurring class of defect — documented guarantees with no enforcement, telemetry that's captured but never surfaced, dual-edit toil that drift-check catches but can't fix, and fully-built tools that slip through registration untested. Each of these four closes one of those gaps with the smallest patch that bites without regressions.

## Notes
- E1 and E4 are CI-only (no runtime change). E2 is read+render plus a single structured-persistence write. E3 is a local developer tool, never a CI mutation.
- No CHANGELOG hand-edit (invariant 12); release-please will regenerate it from this and other pending fragments.
