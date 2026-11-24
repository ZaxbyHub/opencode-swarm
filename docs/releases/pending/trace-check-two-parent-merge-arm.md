# `fix(issue-tracer)`: accept two-parent merge commits in `merge_identity`

## Summary

- `trace-check.sh merge_identity` verified that the MERGED change was the REVIEWED change by comparing stable patch-ids, but it read the merge commit's parents with `%P` and applied `is_hex` to the result. `is_hex` fails for two parents, so the function refused EVERY two-parent merge commit with `merge-identity: expected a squash with one parent` — before it ever evaluated the patch-ids.
- A repository that merges with a merge commit rather than a squash therefore could never have its reviewed change verified by the merge gate; every such trace had to carry a disclosure note instead of a PASS.
- The function now reads the parent COUNT instead of assuming one:
  - **one parent (a squash)** — behaviour is unchanged, exactly as before;
  - **two parents (a merge commit)** — the stable patch-id of `first-parent..merge` is compared with the reviewed `base..head`, because a merge commit's diff against its first parent IS the change that was merged. Both base-ancestor checks are retained;
  - **more than two parents** — refused, with a message that names the shape.
- The acceptance line gains one field for the two-parent case (`merge-identity-second-parent=`); the existing `merge-identity-v1` line keeps its format.

## User-facing changes

A repository whose traces are closed with two-parent merge commits can now have its merge gate PASS on the shape it actually uses. Before this change such a trace could only be closed with a disclosure note, because the validator refused the merge shape outright.

The one-parent squash mode is unchanged: a squash whose content differs from the reviewed change is still refused, and the `merge-identity-v1` acceptance line keeps its existing format.

## Migration notes

None required. The change is confined to the validator's `merge_identity` helper and its `merge-identity` subcommand; no trace format, manifest format, or state file changes.

## Discovery context

Delivered as item 4 of `zaxbysauce/zaxby-hyperv-mcp` issue #167 ("Follow-up from PR #166"), whose owner accepted the request that the two-parent merge arm land in this skill rather than in the repository that vendored it. That issue's own acceptance check drives the user-level copy of this script, so the mirror is re-synced from this commit once it lands.
