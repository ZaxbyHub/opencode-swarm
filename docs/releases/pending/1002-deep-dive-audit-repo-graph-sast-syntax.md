# Deep-Dive Audit Fixes: repo-graph, tree-sitter/WASM, SAST, syntax-check

## What

Resolves the 23 verified findings from the deep-dive audit (#1002) across the
SAST, language-dispatch, tree-sitter runtime, syntax-check, and repo-graph
subsystems.

Security / subprocess hardening:
- The Semgrep subprocess now sets `stdin: 'ignore'`, guarantees a
  SIGTERM→SIGKILL terminate on every settle path, and bounds stdout/stderr
  accumulation (10 MB/stream) — AGENTS.md invariant 3.

SAST rule quality:
- Removed a duplicate `sast/go-hardcoded-secret` rule id.
- Aligned the Java hardcoded-secret length threshold (`{5,}` → `{10,}`) with the
  other C-family languages, cutting false positives.
- Added a context-aware `validate` to the C# `Process.Start` rule so the safe
  `ProcessStartInfo` + `UseShellExecute = false` pattern is no longer flagged as
  a critical command-injection in the hard gate.

Language dispatch + tree-sitter runtime:
- Grammar loading is now wrapped in `withTimeout` and coalesces concurrent loads
  of the same grammar; `node:fs` is statically imported.
- Project language detection now honors glob detect files (`*.csproj`, `*.sln`,
  `*.xcodeproj`, …) so C#/Swift solution-only projects are detected.
- Kotlin ktlint detection uses `build.gradle.kts` instead of the generic
  `.editorconfig`.
- Test-framework names are unified between profiles and the dispatch map, locked
  by a parity test.
- Laravel detection (previously dead code) is wired into a real PHP backend and
  the architect project-context, so Laravel apps surface `php artisan test` and
  `PROJECT_FRAMEWORK = laravel`.

syntax-check:
- Stat-before-read large-file guard, an iterative (stack-safe) parse-tree walk,
  and bounded-concurrency file processing.

repo-graph:
- Comment-aware import scanning to reduce false graph edges.
- The incremental-update failure counter is now per-session, bounded, decaying,
  and cooldown-gated (AGENTS.md invariant 8).

Tests:
- The SAST gate integration tests now run on Windows (git config pinned to
  `core.autocrlf=false`; unrelated gates already mocked).

## Why

The audit surfaced two HIGH-severity subprocess-safety gaps (Semgrep stdin /
kill / unbounded output), several SAST rules producing avoidable false positives
or duplicate findings, an init-path invariant gap (unbounded grammar load), a
session-state invariant violation (shared failure counter), dead Laravel code,
and Windows test-coverage gaps. Each is a latent reliability, security, or
correctness risk on at least one supported platform.

## Migration

No breaking changes. All changes are internal hardening, rule-quality, and
test-coverage improvements:
- Public tool/agent surfaces are unchanged.
- The new PHP backend and Laravel project-context overlay are additive and
  filesystem-only (no new subprocess on the init path).
- Framework-name unification is internal; the dispatch map preserves all
  existing detection behavior (verified by an expanded parity test).

## Caveats

- The Windows SAST integration tests were validated on Linux only (no Windows
  runner is available in CI from this change's authoring environment). The fix
  targets the documented root cause (`core.autocrlf` diff divergence) and relies
  on the already-mocked lint/secretscan/quality gates to keep the test free of
  Windows-fragile subprocess spawning.
- repo-graph import scanning remains regex-based (now comment-aware): AST-based
  extraction was intentionally rejected because the builder runs on the bounded
  plugin-init path (AGENTS.md invariant 1).
