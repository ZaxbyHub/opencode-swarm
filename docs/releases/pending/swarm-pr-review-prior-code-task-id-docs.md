## What changed
- Added explicit `base_ref`/`head_ref` fields to the reviewer context pack so base-branch verification is possible
- Added IMPORTANT note requiring reviewers to verify "new behavior" claims against actual base branch code, not an idealized baseline
- Added task_id uniqueness rules for parallel explorer lane re-dispatch to avoid schema validation errors on retry

## Why
Reviewer findings of "this is new" or "this was introduced by the PR" were being accepted without base-branch evidence. F-1081-01 (cachedShownIds budget gap) was misclassified as MEDIUM before critic correction — both indicate the base-branch verification step was missing from the review template. Additionally, parallel lane re-dispatch during PR #1081 review triggered schema errors due to reused task_id values.

## Migration
No migration required. Advisory-only skill changes.

## Caveats
None.
