# issue-lint step in swarm-pr-feedback follow-up collation

## What

Adds one bullet to the `Collation and budget` section of
`swarm-pr-feedback/references/followup-dispositions.md`: run `issue-lint` on
the follow-up issue body before `gh issue create` (mechanical errors fixed,
semantic notes surfaced to the plan critic) where the workstation tool is
installed. A PreToolUse `issue-lint-gate` hook enforces the same at filing
time.

## Why

The `issue-lint` tool validates issue bodies against the executable-contract
format (contributing.md `CANONICAL-VERSION` stamp): permalinks verified
against git objects at the anchor commit, fenced excerpts byte-exact, EARS
grammar / AC shape / one-AC-one-check, no execution of issue-supplied
commands. The followup-dispositions `Collation` section is the one place the
swarm skill creates issues — this bullet wires the tool into that step so
follow-up issues are mechanically verified before filing.
