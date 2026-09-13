# Required-check contract and release ownership

Issue #2677 adds a small, version-controlled contract for the checks that the
repository expects GitHub to emit. The contract is in
`scripts/required-check-contract.json`; the external capture is in
`docs/ci/required-check-evidence.json`.

## Evidence boundary

The contract records the exact 17 contexts observed in active ruleset
`17809658`, their workflow/job owners, and the events required to produce
them. The separate `intendedRequiredContexts` bucket currently contains
`drift`. This is deliberately truthful: `drift` now runs on pull requests,
pushes to `main`, and `merge_group: checks_requested`, but it is not yet in the
live ruleset.

The capture is public metadata only. It records the repository, protected
branch, active ruleset, merge-group observation, workflow-event facts, source
API endpoints, UTC `capturedAt`, and a capture SHA. Here, `captureSha` pins the
external observation to base commit `b21cdce17b8731143ed5fab7fdf32dd8ad5f7a7f`:
the pinned Contents API blob records show that the base `drift-check.yml` did
not declare `merge_group`, while the two concrete merge-group receipts are CI
run `34639685905` and PR Standards run `34639685670`. The
`capturedWorkflowFiles` entries retain those Contents endpoints and blob SHAs.
The run map explicitly records no base merge-group run for `drift`; its new
local trigger is a proposed change, not retroactive external evidence.
The separate `localWorkflowHashes` entries describe the proposed/current tree
being checked; they are not asserted to have existed at `captureSha`. This
separation makes the external base fact and the locally proposed
`merge_group` trigger auditable without conflating them.

Captures older than 30 days, missing or malformed evidence, branch/ruleset
mismatches, unknown protection or merge-group state, and changed local
workflow hashes fail closed. A missing external `merge_group` event for the
intended-only `drift` context is a visible nonblocking `RULESET_DIVERGENCE`
notice during promotion; the local workflow still must declare the trigger.
The same external event gap for an already-required context is blocking. The
checker never calls GitHub; an authorized operator refreshes the JSON from the
read-only GitHub API and rechecks the pinned endpoint, blob SHA, and capture
commit before landing the capture.

The bounded workflow parser reads only top-level `on` event keys and `jobs`
IDs. It does not infer matrix-expanded or aggregate check names. Those exact
names remain explicit records in the contract and evidence, which prevents a
YAML-only check from claiming that a required status context exists.

Run the local check with:

```sh
bun run scripts/drift-check.ts --enforce --no-report
```

The pre-promotion `RULESET_DIVERGENCE` finding for `drift` is a visible notice
and does not fail enforcement. All missing, renamed, event-skipped, stale, or
unknown evidence for existing required contexts remains blocking. After an
authorized operator observes successful merge-group drift runs, the operator
must add `drift` to ruleset `17809658`, capture the updated ruleset, and move
`drift` into the required bucket. That external ruleset change is intentionally
not performed by this patch.

## Release-owned files

`package.json`, `CHANGELOG.md`, and `.release-please-manifest.json` are exact
root-level release-please-owned files. The CI guard rejects ordinary edits to
them, even when a pending fragment is present. A pull request is authorized
only when the established release-please branch predicate is combined with
the exact trusted actor `github-actions[bot]`. A merge-group guard uses the
anchored head-commit release predicate; the queuing actor is not trusted for
this exception. Pending fragments remain normal files and tags never create a
required `docs/releases/vX.Y.Z.md` path.

If an audited maintainer emergency requires an owner-file correction, use a
reviewed workflow-dispatch procedure that records the actor, commit, reason,
and resulting release-please run. Do not add an environment-variable bypass
to pull-request enforcement.
