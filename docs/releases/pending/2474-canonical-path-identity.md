---
category: Fixed
---

Canonicalize project and existing-file identity across Windows and POSIX so case,
separator, symlink, junction, and Windows 8.3 aliases cannot split project caches,
resource handles, recovery state, or persisted-root comparisons. Recovery
candidate selection is now deterministic across filesystem enumeration orders.
Windows identities retain the persisted forward-slash form after native 8.3
expansion, and learning-health reads legacy raw-directory project refs so
existing `.swarm` artifacts remain visible after upgrade. No migration is
required.
