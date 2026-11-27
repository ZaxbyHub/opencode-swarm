# `fix(guardrails)`: nested compound shell commands (loop/if bodies) no longer hit the bash write-detection parse denial

## Summary

- bash-parser 0.5.0 cannot parse a compound statement nested inside another compound body: `for …; do if …; fi; done`, `while …; do for …; done; done`, and `if …; then for …; done; fi` all throw ("Unexpected 'Then'/'Do'/'In'") although they are bog-standard POSIX shell. Every such command landed on the fail-closed `parseError` denial — blocking purely read-only diagnostic pipelines like `for d in …; do if [ -d "$d" ]; then grep …; fi; done` (observed live in both the architect session and the external watchdog review).
- Fix: structural decomposition on the parse-failure path. The qualifying block **bodies** are replaced by the inert POSIX no-op `:` in a **skeleton** (loop heads, if/elif/else conditions and structure, `done`-redirects, and everything outside the bodies stay verbatim), and every real body is analyzed as its own command line. Writes are **unioned** across skeleton and bodies — every byte of the original command is analyzed in exactly one piece, so a write anywhere is a write of the whole. Any piece that still fails to parse keeps the fail-closed `parseError` (genuinely malformed keyword structure never decomposes: the quote/substitution-aware scanner refuses unbalanced `do`/`done`/`if`/`fi`).
- Safety: detection only grows — `done > file` redirects, writes in if-conditions, writes in loop-head `$(…)` word lists, `rm`/`sed -i` inside nested bodies are all detected (pinned); a `cd`/`pushd`/`popd` in a BODY withdraws every write of the whole decomposed command (`unresolvedContext` → denial), because a body runs zero or more times between skeleton statements, so no write's landing directory is statically provable — a skeleton write after the block and a body write before its own cd both land at the post-cd directory on later iterations; a `cd` in the SKELETON withdraws only body writes (skeleton-internal order is handled by the skeleton's own recursive directory-state walk), mirroring the procsub span semantics; recursion is depth-bounded (2); the empty-directory-removal tag is stripped for decomposed writes (conservative); procsub masking keeps running for commands that combine both shapes.

## User-facing changes

- Read-only shell diagnostics using nested `for`/`while`/`if`/`case` structures pass the write-detection gate instead of being rejected as unparseable. Write-carrying nested structures are still detected and gated exactly as before.

## Migration notes

None. Purely an analysis-path change; no persisted state, event vocabulary, or tool surface changes.

## Discovery context

Reproduced directly from the Wirtschaftssimulation `swarm_communication_debug.md` §3.4 parser class (2026-11-23): the watchdog's blocked read-only pipeline, plus this session's own blocked `for d in …; do if [ -d "$d" ]; then …; fi; done` cache-inspection command. bash-parser isolation: nested compounds throw while the same bodies parse standalone; the `: ;` skeleton substitution parses. Pinned by the nested-compound decomposition tests in `tests/unit/hooks/shell-write-detect-nested-compound.test.ts`; the 83 existing shell-write suites stay green.
