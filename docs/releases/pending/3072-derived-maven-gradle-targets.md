# Derived Maven/Gradle test targets for file selections (issue #3072)

## What changed

`test_runner` with framework `maven` or `gradle`, `scope: "convention"`
(resolution), a non-empty `files` selection, and no explicit `targets` used to
fail with `Framework "maven" does not support targeted test-file execution`
even though the resolved test files map 1:1 to class names for these
frameworks. `runTests` in `src/tools/test-runner.ts` now derives the
framework-native selector from the resolved test-file basenames before the
command build:

- Maven: `-Dtest=<ClassA,ClassB>` as a single comma-joined argument.
- Gradle: one `--tests <Class>` pair per target.

Both the dispatch path (`buildTestCommandViaDispatch`) and the legacy inline
switch receive the same derived `targets`, so argv is identical under
`SWARM_LANG_BACKEND=legacy`.

Also in this change:

- **R2 sibling mapping:** when the resolved test file lives below a nested
  module directory, source files are mapped to their sibling test files
  relative to that module directory (not the repo root).
- **G-nested Gradle detection:** `detectTestFramework` now recognizes nested
  `build.gradle` / `build.gradle.kts` module directories, mirroring the
  existing nested `pom.xml` fallback, so execution cwd resolves to the module
  that actually owns the tests.

## Why

Class-based JVM frameworks cannot take file paths, but a resolved JVM test
selection is exactly a set of test classes. Refusing the selection gave
agents no way to run a targeted Maven/Gradle test sweep through `test_runner`
(issue #3072), forcing the framework-native selector to be hand-written or the
whole suite swept.

Derivation is deliberately fail-closed: it applies only when every selected
file has a JVM test extension (`.java`, `.kt`, `.groovy`) yielding a non-empty
basename. Any other file in the selection derives nothing and the original
structured error is preserved, and explicit `targets` always keep precedence.
Frameworks that take file paths are unaffected — the derivation guard only
matches `maven`/`gradle`, so no other framework's command changes.

## Migration

No configuration change required. Callers that previously passed explicit
`targets` see identical behavior. Callers that previously received the
unsupported-framework error for a pure JVM test selection now get a targeted
run.

## Caveats

- Derivation uses file basenames, so a selection containing a JVM file that
  is not a test class (for example a helper under `src/test/`) derives a
  class name the build tool cannot match. By default maven (Surefire
  `failIfNoSpecifiedTests`) and gradle fail the run with
  `No tests matching pattern ... were executed` rather than passing with
  zero tests; this change deliberately does not set the framework's
  ignore-no-match flag, so the failure stays visible and the caller can
  rescope the selection.
- Scope `all` and `target` are excluded from derivation; native-target
  pairing validation is unchanged.
