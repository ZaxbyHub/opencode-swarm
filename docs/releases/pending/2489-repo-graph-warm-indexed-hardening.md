---
category: Fixed
---

- Made repo-graph warm queries reuse bounded graph-identity indexes, consolidated the legacy parser fallback behind one size-bounded fail-open scanner, and hardened indexed storage with validated rows, bounded LRU handles, safe future-schema recovery, and inode-aware cache invalidation.
