---
category: Fixed
---

# Restore durable, effective coder scope authority

## What changed

- Made coder write authority effective and durable: exact declared scope can authorize intended generated/config outputs without bypassing protected paths, scope bindings survive refresh and restart with typed recovery diagnostics, and plan task `files_touched` now round-trips losslessly through ledger, projections, checkpoints, and approved-plan reads.
- Tightened recursive deletion so only validated artifact targets can be removed, while repository metadata, swarm state, symlink escapes, arbitrary in-scope source trees, and cross-root paths remain protected.

## Why

Coder scope could previously disagree across planning, delegation, restart, and file-authority layers. That produced false denials for legitimate outputs, generic or stale recovery guidance, and overly broad recursive-delete exceptions.

## Migration and compatibility

Existing plans and legacy persisted scope bindings continue to load. Re-saving a task without `files_touched` preserves its prior scope; pass an explicit empty list only when the scope should be cleared.
