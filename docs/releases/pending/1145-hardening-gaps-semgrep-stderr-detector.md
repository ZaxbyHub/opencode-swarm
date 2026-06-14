# Hardening gaps from PR #1142 review (issue #1145)

## What changed

Six low-severity hardening gaps identified in the PR #1142 review are addressed:

- **F-001 / F-003 — `src/sast/semgrep.ts`:** The stderr truncation handler now calls
  `child.kill('SIGTERM')` immediately upon cap breach (matching the existing stdout
  path). Both stdout and stderr byte accounting now uses `Buffer.byteLength(chunk, 'utf8')`
  instead of `string.length`, so the 10 MB per-stream cap is measured in bytes
  rather than UTF-16 code units. Slicing uses `Buffer.subarray` to stay within the
  byte budget for multibyte output.

- **F-004 — `src/lang/detector.ts`:** Glob-pattern matching (e.g. `*.csproj`) against
  directory entries now filters to regular files only via `Dirent.isDirectory()`,
  so a directory named `MyProject.csproj` no longer triggers false language detection.

- **F-005 — `src/sast/rules/java.ts`:** The comment example `token: "abcde"` updated
  to `token = "abcde"` to match the `=` assignment pattern the regex actually checks.

- **F-006 — `src/lang/backends/php.ts`:** Removed the unused `_internals` export
  (`{ selectFramework }`) — `selectFramework` is not injected by any external consumer
  and the export served no testing purpose.

## New tests

- `tests/unit/sast/semgrep.test.ts`: two new cases — stderr cap parity (F-001) and
  SIGKILL escalation after SIGTERM grace period.
- `tests/unit/tools/syntax-check.test.ts`: deep-nesting traversal test with 10,000
  levels of JSON nesting (DD-C018 explicit stack path).
- `tests/unit/lang/php-backend.test.ts`: five edge-case Laravel detection scenarios
  (capitalized Artisan, single signal, malformed composer.json, empty dir, two-signal
  without config/app.php).
- `tests/unit/lang/detector.test.ts`: three adversarial cases (malformed package.json,
  directory named `*.csproj`, circular symlink).

## Migration

No migration required.

## Known caveats

None.
