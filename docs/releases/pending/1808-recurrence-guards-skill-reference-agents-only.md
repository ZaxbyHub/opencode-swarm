# Recurrence guards: skill-reference drift, agents-only mirrors, subcommand parity (issue #1808 PR-4/6)

## What

Three hardening improvements to the drift-check and skill-mirror systems, all targeting silent contract divergence that recurrence patterns tend to produce.

### SC-009 — `file:` SKILL.md reference drift detector

`scripts/drift-check.ts` now validates that every `file:.swarm/bundled-skills/` or sibling-tree `file:` reference in any `SKILL.md` actually resolves to a skill in the current bundled-skills list or known mirror tree. A new `detectSkillReferenceDrift` detector catches three failure modes:

- **Stray references** — a `file:` path points to a skill not in `BUNDLED_PROJECT_SKILLS` and not in any known mirror tree.
- **Missing bundled copy** — a skill exists on disk but is not in `BUNDLED_PROJECT_SKILLS` and has no mirror contract, so it would not be published.
- **Stale sibling references** — a `file:` in a `.claude`/`.opencode` tree points to a skill that has since moved to `.swarm/bundled-skills/` (or vice versa).

`listSkillFilesRecursively` walks all three native skill trees plus `.swarm/bundled-skills/` to build the authoritative reference list.

### agents-only contract kind for `.github/skills/`

`.github/skills/` (GitHub Actions skill adapters, not skill mirrors) was unclassified in `skill-mirrors.ts`, causing the drift checker to warn about it as an "unknown" directory. The `SkillMirrorContract` kind union is extended to include `'agents-only'`, which opts the directory out of byte-identical mirroring and out of drift warnings while still listing it in the skills inventory.

### Subcommand parity test (SC-001–SC-005)

New `tests/unit/commands/swarm-subcommand-parity.test.ts` asserts that every entry in `COMMAND_REGISTRY` appears in the 86 documented `/swarm` commands. New `tests/unit/scripts/drift-check-reference-resolver.test.ts` covers SC-001–SC-005 skill-reference resolution invariants (file protocol resolution, cross-tree lookup, divergent/agents-only existence checks, SC-009 unclassified directory detection).

### `extraIdenticalPaths` existence enforcement

For `divergent` and `agents-only` contracts, the drift checker now verifies that every path listed in `extraIdenticalPaths` actually exists on disk. Previously a typo in this list would be silent; now it is flagged as a configuration error. `skill-mirrors.test.ts` gains 47 total tests covering this plus the new branches.

### SC-010 — Duplicate slug detection across contract arrays

`scripts/drift-check.ts` now checks that no slug appears in more than one `SkillMirrorContract` entry's slug list. A slug duplicated across contracts (e.g. `commit-pr` in both a `divergent` and a `mirror` contract) causes silent overwrite at runtime and is now a hard error. `tests/unit/scripts/drift-check-reference-resolver.test.ts` covers this invariant.

### SC-012 — Duplicate `package.json#files` entry detection

`scripts/drift-check.ts` now validates the `files` array in `package.json` for duplicate entries. A duplicate glob or path in `files` is silently ignored by `npm pack`, potentially excluding published assets without warning. The drift checker now flags this as a configuration error. Coverage is added to the existing reference-resolver test suite.

### SC-016 / SC-017 — Commit-pr validation suite parity test

New `tests/unit/commands/commit-pr-validation-parity.test.ts` asserts that every obligation in the `commit-pr` skill's `ObligationLedger` has a corresponding entry in the commit-pr validation suite (`scripts/check-commit-pr.ts` or equivalent). SC-016 covers obligation completeness; SC-017 covers the inverse — that no validation entry exists without a documented obligation. This closes the feedback loop between documented workflow contracts and actual CI enforcement.

### SC-018 / SC-019 — `CANDIDATE` marker contract test with behavioral assertions

New `tests/unit/commands/candidate-marker-contract.test.ts` covers the `CANDIDATE` marker lifecycle: that a skill with `status: candidate` in its `SKILL.md` frontmatter is correctly surfaced by `listSkillFilesRecursively`, correctly excluded from `BUNDLED_PROJECT_SKILLS` at registration time, and correctly excluded from the drift-checker's published-skills inventory. SC-018 tests the surface/filter logic; SC-019 tests that behavioral contracts (e.g. `audience`, `trigger` presence) are validated even for candidate-status skills.

## Why

Recurrence amplifies small configuration drift. The skill-mirror system had a quiet assumption that all unclassified directories were mirrors — but `.github/skills/` is an adapter tree, not a mirror. Similarly, `extraIdenticalPaths` typos are invisible unless something specifically reads the contract. The reference drift detector closes the loop between "documented in SKILL.md" and "actually published."

## Notes

- No runtime behavior change. All changes are CI/test only or configuration validation.
- `.github/skills/commit-pr/SKILL.md` is added to the `commit-pr` contract `extraIdenticalPaths` to reflect its actual location alongside the canonical `.agents/skills/commit-pr/SKILL.md`.
- The `agents-only` kind is intentionally non-mirrored; adapters in `.github/skills/` are not required to be byte-identical to anything else.
