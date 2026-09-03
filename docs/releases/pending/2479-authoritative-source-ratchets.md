# Make source-quality ratchets authoritative

## Fixed

- Pin Zod exactly and snapshot the generated schema's datetime and tuple semantics, preventing dependency drift from silently changing the committed schema.
- Make CI drift enforcement unconditional, add a cross-platform pre-push aggregate, and fail coverage shards that produce no LCOV artifact.
- Replace comment- and file-level heuristics with lexical/AST checks for mock cleanup and subprocess timeouts, and close fabricated historical-citation bypasses in the atomic-write registry.
- Finish the still-live #1248 regressions for UTF-8 byte caps, process-kill diagnostics, symlink fixtures, and deep syntax verdicts.
