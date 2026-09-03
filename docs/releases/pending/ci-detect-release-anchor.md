### CI: the merge-queue release predicate no longer skips tests for non-release merges

The `detect-release` job decides whether a merge group is a release-please
merge; when it says yes, every CI job skips its steps and reports success.
Its check grepped the full commit message for the unanchored token
`release-please--`, so a pull request whose description mentioned that branch
name, or contained a body line beginning `chore(main): release`, caused a
non-release merge group to skip the entire suite while every required check
reported green. The predicate now inspects only the commit subject and matches
the two genuine release shapes with anchored patterns. A table-driven test
pins the literal and runs positive and negative controls. No configuration or
migration changes.
