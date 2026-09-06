# Safe post-release fragment cleanup

- Release automation now binds consumed release-note fragments to the exact
  published tag and content hashes, preserves the full GitHub Release body in
  versioned repository history, and proposes cleanup through a reviewable PR.
- Cleanup is dry-run-first and deletes only byte-identical consumed fragments;
  changed, renamed, ambiguous, or unconsumed files are retained and reported.
- Drift CI enforces a bounded pending-fragment backlog and detects consumed
  fragments that were accidentally left behind.
- Historical reconstruction uses capped tag batches with snapshot-bound resume
  cursors, so partial backfills cannot silently truncate or lose their place.
