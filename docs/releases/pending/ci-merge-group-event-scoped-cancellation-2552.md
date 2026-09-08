# CI: Scope cancellation to merge-group supersession (Issue #2552)

## What changed

- Changed the top-level CI concurrency policy to cancel only superseded
  `merge_group` runs: `cancel-in-progress: ${{ github.event_name == 'merge_group' }}`.
- Pull-request and manual workflow runs remain non-cancelling, preserving their
  required-check status behavior.
- Pinned the exact expression and rejected unconditional `true`/`false` values
  in the focused issue #2552 structural test.
- Recorded two qualifying post-land Stage-A full-matrix receipts and their
  merge-queue timeline evidence in the policy decision record at publication
  time; the third, run `34162959243`, was collected after this change landed
  and completes the Stage-A set. Run `34121635625` is excluded because its
  release-please short-circuit skipped the CI matrix.

## Why

Merge-group candidates reuse queue refs as their head changes. Cancelling an
obsolete merge-group run releases that ref for the newer candidate, while
pull-request and manual runs still need the non-cancelling behavior that avoids
stale required statuses.

## Migration

No migration is required. The workflow and required-check configuration remain
otherwise unchanged.

## Breaking changes

None.

## Known caveats

The account-level concurrency cap and canonical run-level runner queue wait are
unavailable. Post-item-B receipts were required before issue #2552 could close;
receipt `34162959243` was collected after this change landed and completes that
evidence stage.
