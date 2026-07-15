# Skills Quality Audit — PR-4/6 Recurrence Guards

## What changed
PR-4 of the 6-PR skills quality audit. Adds six new detectors to `scripts/drift-check.ts`, extends the `skill-mirrors.ts` contract with a new `adapter`/`agents-only` kind taxonomy, and hardens four parity-test suites that pin behavioral invariants from the skill prose:

- **NEW DETECTOR — Skill-reference resolver**: validates every `file: SKILL.md` reference across all tracked skill trees against the bundled skills list and sibling mirror contracts. Catches references to slugs that no longer exist or that have moved trees.
  - **Cycle prevention hardening**: `listSkillFilesRecursively` now uses `realpathSync` to canonicalize physical paths before adding to the visited Set, preventing symlink-based infinite recursion during traversal.
  - **SC-006 multi-level sibling reference tests**: added test coverage for multi-level `../../` sibling reference resolution paths.
  - **SC-010 extended**: duplicate-slug detection now covers `ADDITIONAL_SKILL_MIRROR_CONTRACTS` in addition to the five primary contract arrays.
- **NEW DETECTOR — Duplicate-slug detection**: cross-checks all five contract arrays (`MIRRORED`, `DIVERGENT`, `ADAPTER`, `OPENCODE_ONLY`, `ADDITIONAL`) for duplicate slug entries. Each slug must appear in exactly one contract bucket.
- **NEW DETECTOR — Duplicate `package.json#files` entry detection**: scans the `files` array for duplicate `.opencode/skills/` entries that would cause the pack script to include the same path twice.
- **NEW DETECTOR — Divergent `extraIdenticalPaths` existence check**: validates that any paths listed in a divergent contract's `extraIdenticalPaths` array actually exist on disk, so drift-check can correctly scope diffs for contracts that share only a subset of paths. The array itself is optional — omitted arrays pass silently.
- **NEW DETECTOR — `agents-only` kind handler**: validates `extraIdenticalPaths` existence for the new `agents-only` contract kind (contracts that have a `.agents/skills/` copy but no `.claude/` twin).
- **NEW DETECTOR — SC-009 unclassified directory detection**: flags `.agents/skills/` and `.github/skills/` directories that are not covered by any mirror contract, preventing silent additions to trees that drift-check does not track.

- **CONTRACT UPDATE — `.github/skills/commit-pr/SKILL.md`**: added to the `commit-pr` divergent contract's `extraIdenticalPaths`, closing the gap between the `.claude/skills/commit-pr/SKILL.md` primary and its `.github/skills/` twin.
- **CONTRACT UPDATE — 14 orphaned entries reclassified**: entries in `ADDITIONAL` and `OPENCODE_ONLY` that had a `.agents/skills/` copy but no `.claude/` twin are now typed as `kind: 'agents-only'` with their `extraIdenticalPaths` declared, making them visible to the new detector and to future consumers that need to distinguish agents-only skills from opencode-only skills.
- **CONTRACT UPDATE — Type union extended**: `MirrorKind` union now includes `'adapter'` and `'agents-only'`, aligning the type with the full taxonomy in use.
- **CONTRACT UPDATE — Stale comment removed**: the outdated "agents-only handler is TODO" comment in `skill-mirrors.ts` is replaced with a note pointing to the new detector.

- **PARITY TEST — Subcommand registry (86 commands)**: `tests/unit/commands/swarm-subcommand-parity.test.ts` now asserts all 86 documented `/swarm` commands in `COMMAND_REGISTRY` are covered by the subcommand parity test, closing a silent drift path where new commands could be added without a corresponding skill.
- **PARITY TEST — Commit-pr canonical scripts (9 scripts)**: `tests/unit/skills/commit-pr-validation-parity.test.ts` now asserts all 9 canonical scripts referenced in `.claude/skills/commit-pr/SKILL.md` are present:
  1. `bun run typecheck`
  2. `bun run lint:ci`
  3. `bun run build`
  4. `scripts/check-tool-registration.ts`
  5. `scripts/check-mock-cleanup.sh`
  6. `scripts/check-invariants.sh`
  7. `scripts/check-cross-contamination.sh`
  8. `scripts/check-test-clock.sh`
  9. `bun run test:unit:ci`
- **PARITY TEST — `[CANDIDATE]` marker contract**: `tests/unit/background/candidate-marker-contract.test.ts` now pins the `[CANDIDATE]` marker convention between lane prompts and the parser with behavioral assertions calling `parseCandidates`: verifies valid `base_explorer` and `micro_lane` rows parse correctly, malformed rows are rejected, and the header-only marker convention is enforced.
- **PARITY TEST — `<loop-complete/>` XML marker grammar**: `tests/unit/skills/loop-complete-grammar.test.ts` now pins the `<loop-complete/>` XML marker attribute grammar (`reason`, `cycles`) to catch attribute grammar drift in the marker's skill-prose definition.

## Why
Issue #1808: the drift-check script had no recurrence guards — it could detect the same category of drift multiple times across consecutive runs without any structural enforcement preventing new duplicates. The new detectors close gaps that previous PRs left unresolved: invalid or nonexistent paths listed in `extraIdenticalPaths`, duplicate slugs across buckets, and directories that landed in untracked trees. The parity tests prevent the skill prose from drifting away from the runtime behavior they describe (the problem PR-1 catalogued).

## Migration
None. All changes are additive: new detectors produce drift findings with severity error, the new `agents-only` kind is opt-in via the `kind:` field, and the parity tests are new test files.

## Breaking
None. No runtime behavior changes; drift-check findings are severity error by default.

## Test plan
- `bun run drift:check` — 0 findings (enforcement level); all 6 new detectors emit 0 warnings on the current contract state.
- `bun run typecheck` — clean.
- `bun --smol test tests/unit/scripts/drift-check-reference-resolver.test.ts tests/unit/commands/swarm-subcommand-parity.test.ts tests/unit/skills/commit-pr-validation-parity.test.ts tests/unit/background/candidate-marker-contract.test.ts tests/unit/skills/loop-complete-grammar.test.ts` — all parity and contract tests pass.
- `bun --smol test tests/unit/skills/skill-mirrors.test.ts` — skill-mirrors contract coverage complete.

## Caveats
- This is PR-4/6 of the skills quality audit. PR-1 (truth sweep, #1804/PR-1812) and PR-3 (reachability wiring, #1806/PR-1814) are already merged. PR-2 (swarm-pr-review/execute canonicals) was sequenced before this PR but merges after. PR-5/6 cover structural splits and gate-integrity code.
- The 14 reclassified `agents-only` entries may produce one-time drift-check warnings on consumer repos that have not yet synced the updated contract. These are false positives against the reclassified slugs and will self-resolve on the next `drift:check` run after the contract update is deployed.
- SC-009 unclassified directory detection may flag `.github/skills/` in repositories that host their own skill trees — these can be resolved by adding a formal mirror contract entry.

(End of file - total 41 lines)
