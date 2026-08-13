# Hardening gaps from PR #1142 review (issue #1145)

## What changed

Five low-severity hardening gaps identified in the PR #1142 review are addressed. All 17 follow-up items from the PR #1194 review are also covered:

- **F-001 / F-003 — `src/sast/semgrep.ts` and `src/utils/external-tool-runner.ts`:**
  Semgrep now runs through the shared bounded subprocess runner. Both output streams
  are capped in UTF-8 bytes, an overflow triggers immediate process-tree termination,
  and incomplete output fails closed. Raw scanner stderr is never returned to callers
  or written into durable evidence; callers receive a stable classified diagnostic.

- **F-004 — `src/lang/detector.ts`:** Glob-pattern matching (e.g. `*.csproj`) against
  directory entries now filters to regular files only via `Dirent.isDirectory()`,
  so a directory named `MyProject.csproj` no longer triggers false language detection.

- **F-005 — `src/sast/rules/java.ts`:** The comment example `token: "abcde"` updated
  to `token = "abcde"` to match the `=` assignment pattern the regex actually checks.

- **F-006 — `src/lang/backends/php.ts`:** Removed the unused `_internals` export
  (`{ selectFramework }`) — `selectFramework` is not injected by any external consumer
  and the export served no testing purpose.

## New tests

- `src/sast/semgrep.test.ts`: focused regressions cover stderr cap parity, immediate
  overflow termination through the real shared runner, redacted failure diagnostics,
  and single-flight availability probing. `tests/unit/utils/external-tool-runner.test.ts`
  covers the shared runner's bounded termination and signal-escalation state machine.
- `tests/unit/tools/syntax-check.test.ts`: deep-nesting traversal test with 10,000
  levels of array nesting (DD-C018 — verifies explicit stack-based JSON traversal
  avoids recursive call-stack overflow on pathological input).
- `tests/unit/lang/php-backend.test.ts`: six edge-case Laravel detection scenarios
  (capitalized Artisan, uppercase ARTISAN case-sensitivity, single signal, malformed composer.json,
  empty dir, two-signal without config/app.php).
- `tests/unit/lang/detector.test.ts`: seven adversarial edge-cases (unreadable path, non-existent
  directory, unknown extensions, glob-pattern file detection, malformed package.json,
  directory named `*.csproj`, circular symlink).

## Migration

No migration required.

## Known caveats

None.
