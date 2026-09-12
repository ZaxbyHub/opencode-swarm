# test_runner/mutation_test: bounded multi-source scope, analyzer-derived mutation selection, language-aware equivalence (issue #2492)

## What

Makes scoped test and mutation batches safe and efficient (issue #2492,
workstream E5 / source issues #1644 + #1653, with the 2026-09-05 and
2026-09-09 audit additions):

test_runner (src/tools/test-runner.ts):
- Bounded multi-source graph/impact/convention batches: the single-source
  pre-resolution cap (MAX_SAFE_SOURCE_FILES=1) is removed; multi-source
  batches run whenever the resolved, deduplicated test-file union stays under
  MAX_SAFE_TEST_FILES=50. The binding guard is the post-resolution count —
  the fail-open estimateFanOut estimator stays as an advisory early-out only
  and can never be the safety decision.
- Union overflow returns the typed scope_exceeded with a cap_decision
  { decision: 'cap_exceeded', resolved_test_count, limit } — never a silently
  truncated partial set.
- Responses now report resolved_test_files, cap_decision, and fallback_reason,
  and a discovery scope that legitimately resolves zero tests returns the new
  typed outcome no_impacted_tests (distinct from error/skip).
- Fixed the graph-discovery infinite loop: the import-scanning loop
  `continue`d on external package imports (e.g. 'bun:test') without advancing
  the regex, hanging any graph-scope resolution on real-world test files.

mutation_test (src/tools/mutation-test.ts):
- New optional source_files argument: impacted tests are derived via the
  existing impact analyzer (bounded by the safe cap). Explicit files win
  (override); empty derivation, analyzer failure, or cap overflow returns a
  typed bounded fallback — never a silent broad run.
- Responses now report test_selection { source, resolved_test_files,
  fallback_reason? }, evaluability { evaluable, reason }, per-outcome counts
  (killed/survived/equivalent/skipped), and cache_refreshed.
- Every completed gate verdict invalidates the cached impact-map selection
  (O(1) unlink; the next load rebuilds from current test imports).

Equivalence (src/mutation/equivalence.ts + engine.ts):
- Language-aware comment filtering: '#' languages (Python/Ruby/shell/YAML/
  TOML), '--' (SQL/Lua), PHP's dual //+#, and the default //+/* */ family.
  A comment-only mutant classifies equivalent in its own language.
- Fixed the engine's diff reconstruction: unified-diff context lines kept
  their leading marker space, so reconstructed code never matched the
  original byte-for-byte and static equivalence could not fire on
  unified-diff mutants.

Impact cache (src/test-impact/analyzer.ts):
- Test-side staleness: a changed (edited imports/content) or deleted mapped
  test file now marks the impact-map cache stale — the audit-proven stale-map
  class where repointing a test's import kept serving the old source/test
  mapping until some source file changed.

Go imports (src/lang/backends/go.ts):
- Grouped-import blocks are comment-stripped before quoted-path matching:
  a quoted string inside a // or block comment ("legacy/db/pkg") no longer
  becomes a phantom import edge; grouped, alias, dot, and side-effect imports
  are retained.

## Why

The 2026-09-02 roadmap re-baseline closed #1644/#1653 into #2492, but only
the safety half shipped (v7.19.2/v7.20.0): the multi-source permit, the
mutation-side analyzer derivation, the language-aware equivalence gate,
test-side cache identity, and the Go grouped-import false edge were never
delivered. Two of those were live defects (the graph-discovery hang on
external imports; the diff-reconstruction whitespace bug that made the static
equivalence stage dead for unified-diff mutants).

## Migration

No breaking changes:
- test_runner responses gain optional fields (resolved_test_files,
  cap_decision, fallback_reason) and one new outcome value
  (no_impacted_tests); existing outcome consumers keyed on specific values
  are unaffected (no exhaustive switch found; the sweep is in the PR body).
- mutation_test's files argument becomes optional when source_files is
  provided; the schema, executor, and help text were updated together.
- The bounded multi-source contract supersedes the "call test_runner once per
  source file" guidance; tests encoding the old single-source rejection were
  updated to assert the new typed behaviors.
