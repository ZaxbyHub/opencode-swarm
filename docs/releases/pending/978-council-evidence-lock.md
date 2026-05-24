# Council Evidence Write Lock + Atomic Write

## Overview

Fixes a lost-update / torn-write race on `.swarm/evidence/{taskId}.json`. The Work-Complete council evidence writer performed an **unlocked, non-atomic** read-modify-write on the same task evidence file that the delegation-gate hook guards with an exclusive lock and an atomic temp+rename write. When a council write and a gate-evidence write for the same task interleaved, the council write could clobber a freshly-recorded gate entry (e.g. drop the `test_engineer` gate, producing a false "gate not passed" completion block) or leave a torn file.

This is distinct from #970: that issue fixed task-ID *resolution* on the hook path. `submit_council_verdicts` already receives an explicit, validated `taskId`, so it was never affected by misattribution — the defect here is concurrency/atomicity, not task-ID resolution.

## What changed

- Added `src/evidence/task-file.ts` as the single source of truth for safe writes to the flat `.swarm/evidence/{taskId}.json`: `taskEvidenceRelPath` (the shared lock key), `taskEvidencePath`, `atomicWriteFile` (temp+rename), and `withTaskEvidenceLock`.
- `writeCouncilEvidence` (`src/council/council-evidence-writer.ts`) is now async and performs its read-modify-write inside `withTaskEvidenceLock`, writing via `atomicWriteFile`. It now serializes against the delegation-gate hook on the same task file.
- `src/gate-evidence.ts` was refactored onto the shared helpers (behavior-preserving — identical lock key, identical atomic write, identical output).
- `submit_council_verdicts` (`src/tools/convene-council.ts`) now awaits the evidence write; a lock-timeout surfaces as a structured tool failure via the existing `createSwarmTool` error wrapper.

## How to use

No changes needed. Council and gate evidence writes to the same task file are now mutually exclusive and atomic.

## Migration

No migration required. No change to the evidence file path or JSON shape.

Closes: #978
Related: #970, PR #971
