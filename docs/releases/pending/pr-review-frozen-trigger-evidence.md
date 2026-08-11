# PR-review frozen trigger evidence finalization

## What changed

- `write_pr_review_trigger_eval` now accepts omitted or reworded duplicate evidence and persists the authoritative evidence frozen by the first micro dispatch.
- Exact classifications, matched-lane provenance, ownership, revision, head, base, and lane-floor checks remain fail-closed.

## Why

Final review agents could regenerate semantically equivalent evidence text after all micro lanes completed. Byte-for-byte digest comparison then rejected the final receipt, leaving the workflow unable to complete even though classifications and provenance were valid.

## Migration

None. Existing callers may continue sending evidence; callers can also omit it at finalization.

## Breaking changes and known caveats

None.
