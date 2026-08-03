## What changed

`resolveCommitCountSince`/`resolveCommitCountSinceAsync` and
`resolveIsExactSingleChildCommit`/`resolveIsExactSingleChildCommitAsync` in
`src/background/workspace-snapshot.ts` now validate the `baseHeadSha`/
`currentHeadSha` revision tokens they receive with the same
`isSafeGitRevisionToken` guard their sibling resolvers (`resolveExactMergeBase`,
`resolvePrReviewDiffStats`) already use, and append a `--` terminator to the
underlying `rev-list`/`rev-parse --verify` calls.

## Why

These two resolvers built Git command arguments directly from PR-workflow
state (`baseHeadSha`/`currentHeadSha`) without validating the tokens first.
`normalizePrHeadSha` only trims and checks non-emptiness, so a value shaped
like a Git option (for example, starting with `-`) was not rejected before
reaching the underlying `git rev-list`/`git rev-parse` calls. Because these
are array-form `spawn`/`spawnSync` invocations (not shell string
concatenation), classic shell injection was never possible, but an
option-injection vector against `rev-list`/`rev-parse` remained. Found by an
automated Copilot review on PR #1952.

## Migration steps

No migration required. Both resolvers now return `null` (their existing
fail-closed shape) for a revision token that fails validation, instead of
passing it to Git.

## Breaking changes

None.

## Known caveats

None.
