---
title: Harden SQLite plan-ledger cutover and recovery
---

- Harden SQLite plan-ledger authority during reset, including read-only probes and reset-marker race protection.
- Surface rollback and reset compensation failures with actionable diagnostics.
- Bound legacy JSONL archive retention and use collision-safe temporary archive staging with cleanup on failure.
- Add focused regression coverage for migration cutover, reset races, compensation, retention, and temporary-file cleanup.

Migration and compatibility: no user action is required. File-shadow compatibility remains available during the SQLite cutover; legacy archives are retained under the documented bounded retention policy.

Breaking changes: none.
