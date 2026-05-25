---
category: fix
---

## fix(gate-evidence): distinguish ENOENT from corruption errors in readExisting

`readExisting()` was catching all errors and returning `null`, conflating "file not found" (ENOENT) with "file is corrupted" (ZodError, SyntaxError). This caused corrupted evidence files to be silently treated as missing, losing gate pass records.

The fix mirrors the pattern already used by `readTaskEvidenceRaw()`:
- ENOENT → return `null` (file not found, safe)
- Other errors (ZodError, SyntaxError, permission) → throw + emit `gateParseError` telemetry

Both callers (`recordGateEvidence`, `recordAgentDispatch`) are now wrapped in try-catch that re-throws after emitting telemetry, preventing silent data loss.

**Migration**: No migration required.
