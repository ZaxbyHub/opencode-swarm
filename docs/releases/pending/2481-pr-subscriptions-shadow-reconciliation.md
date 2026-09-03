## Fixed PR subscription shadow reconciliation

- `pr-subscriptions` now keeps settled legacy shadows in sync instead of
  archiving them too early or leaving stale content behind.
- Archive-staging residues (`.next` / `.previous`) now force the legacy
  reconciliation path instead of bypassing it through the coordination fast path.
- Recreated legacy shadows are rewritten back to a clean projection after writes,
  so readers keep seeing the checkpoint view while the shadow remains visible.

Why:

- Same-size rewrites and interrupted archive swaps could leave the PR subscription
  store in a state where coordination writes skipped legacy repair.
- That caused stale or inconsistent legacy files to survive, or live legacy
  data to be archived when it should still have been visible.

Migration:

- No migration required.

Known caveats:

- The fix is intentionally narrow to PR subscription coordination and legacy
  archive reconciliation. Other background store flows are unchanged.
