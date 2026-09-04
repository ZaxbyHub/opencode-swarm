# Make source-quality ratchets authoritative

## Fixed

- Pin Zod exactly and snapshot the generated schema's datetime and tuple semantics, preventing dependency drift from silently changing the committed schema.
- Make CI drift enforcement unconditional, add a cross-platform pre-push aggregate, and retry coverage shards when a passing test transiently produces no LCOV artifact before failing closed. Coverage shards request Bun's LCOV reporter explicitly and wait a bounded five seconds for its post-test flush, preventing a passing test from being misclassified when the report write lands just after process exit.
- Replace comment- and file-level heuristics with lexical/AST checks for mock cleanup and subprocess timeouts, and close fabricated historical-citation bypasses in the atomic-write registry.
- Finish the still-live #1248 regressions for UTF-8 byte caps, process-kill diagnostics, symlink fixtures, and deep syntax verdicts.
