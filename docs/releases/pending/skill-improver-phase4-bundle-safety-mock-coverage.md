# Skill improvements: bundle-safety (FR-007) + writing-tests mock-coverage docs (FR-006) + provenance stamping regression test (FR-008)

## What changed

### New skill: `bundle-safety` (FR-007)

Created a new consolidated generated skill (`bundle-safety`) that compiles bundle-transform-safety knowledge targeting `coder`, `reviewer`, and `test_engineer` agents. The skill covers four areas:

- **Minification variant selection** — Identifier-preserving minify (`--minify-whitespace --minify-syntax`) is the standard; full identifier mangling (`--minify-identifiers`) is rejected because it breaks 13 grep guardrail assertions and stack-trace readability.
- **Consumer-constraint verification before transforms** — Before merging any minification or transform change, build the smallest possible test bundle and run the 13 grep guardrails first; only merge if all pass.
- **Identifier-preservation testing** — Layered static (grep) and runtime (stack trace) verification of identifier names in the built output.
- **Namespace re-export coverage** — Both `export * from './module'` (regular) and `export * as ns from './module'` (aliased) must be tested when modifying re-export tracking; they are distinct AST forms.

### Updated skill: `writing-tests` — Mock Coverage Documentation (FR-006)

Added a new `## Mock Coverage Documentation` section requiring that partial-coverage mocks document untested branches inline. When a test fixture mocks fewer than 100% of a target function's branches, the test MUST comment which paths are untested and why. The motivating case is `tests/unit/turbo/lean/runtime-conformance.test.ts:457`, where a narrow mock produced hollow coverage that initially misdiagnosed a later failure.

The required comment format lists: (1) which branches/paths are untested, (2) why they are not covered (e.g., covered by another test file, requires live store, tested at integration level). This applies to all three mock tiers (`_test_exports`, `_internals`, `mock.module`) whenever the mock narrows the exercised branch set.

### Regression test: provenance stamping (FR-008)

Added `tests/unit/services/skill-generator-stamping.test.ts` to lock in the `generated_skill_slug` provenance-stamping mechanism. The R2 finding ("0 stamps") was historical; going forward, skill compilations stamp correctly. The regression test verifies that regenerated skills retain their `generated_from_knowledge` and `source_knowledge_ids` provenance metadata across regeneration cycles.

## Why

- **bundle-safety**: The minification and re-export knowledge was scattered across tribal memory and issue threads. Consolidating it into a skill ensures coder/reviewer/test_engineer agents receive consistent guidance when modifying build transforms or export tracking logic.
- **writing-tests mock-coverage**: Hollow mock coverage produced a false confidence scenario where a test passed but exercised only one branch of a multi-branch function. Making partial-coverage decisions explicit and reviewable prevents future misdiagnosis.
- **provenance stamping regression**: The R2 finding that compilations were producing "0 stamps" was traced to a historical state. The regression test ensures the stamping mechanism stays locked going forward.

## Migration

No migration required. Skills are consumed automatically by the swarm plugin's skill injection system. The writing-tests mock-coverage requirement is a new guidance section; existing tests are not automatically changed.

## Breaking changes

None.

## Known caveats

- The bundle-safety skill's `MAIN_BUNDLE_MAX_BYTES = 8.0 MiB` gate in the reviewer checks references a specific packaging test; keep the reviewer guidance synchronized if that threshold changes again.
- The writing-tests mock-coverage requirement applies to new tests and tests that add new partial mocks; existing tests with undocumented partial mocks are not auto-updated.
