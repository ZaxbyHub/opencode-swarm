# Fix release notes aggregation for commit-SHA-only changelogs

## What changed

- **`scripts/release-notes-fragments.mjs`**: The aggregation script now handles
  release-please changelogs that link to commit SHAs instead of PR numbers.
  - Added `extractCommitShasFromBody(body)` (exported pure helper): extracts
    full 40-char commit SHAs from GitHub `/commit/<sha>` URL patterns in the
    release body. Short 7-char labels in link text are not extracted — only the
    full SHA embedded in the URL target is used.
  - Added `resolveCommitShasToNprNumbers(shas, log)`: for each SHA, calls
    `GET /repos/{owner}/{repo}/commits/{sha}/pulls` via `gh api` to find the
    PR(s) that introduced it, then collects their numbers for fragment lookup.
  - Updated `modeUpdatePr` and `modeUpdateRelease` to first try the existing
    direct PR-number extractor (`(#N)`, `[#N](url)`, `/pull/N`), then fall back
    to commit-SHA resolution. Both result sets are merged (deduped) before
    fragment collection.
  - Improved logging in both modes: now reports how many direct PR refs were
    found, how many commit SHAs were found, how many PRs were resolved from SHAs,
    and which candidate PRs will be checked for fragments. Multiple-PR-per-commit
    edge cases are explicitly logged.
- **`.github/workflows/release-and-publish.yml`**: Added `pull-requests: read`
  permission to the `update-release-notes` job so `gh api .../commits/{sha}/pulls`
  succeeds (the new commit→PR resolution needs to read PR metadata).
- **`tests/unit/scripts/release-notes-fragments.test.ts`**: Added 9 new unit
  tests for `extractCommitShasFromBody` covering normal extraction, case
  normalisation, empty input, short-SHA non-extraction, deduplication, multiple
  SHAs, invalid-length strings, non-hex characters, and a real-world
  release-please body format. Also added a rerun-defence test proving that
  commit SHAs cited inside a previously-injected custom block are stripped
  before scanning, preventing spurious re-resolution on subsequent runs.

## Why

`release-please` with `changelog-notes-type: "github"` generates changelog
entries that reference the merge commit SHA rather than the source PR number
when PRs are merged using GitHub's standard merge commit strategy (not squash).
Example:

```
* **skills:** add feature ([ba948b4](https://github.com/.../commit/ba948b40...))
```

The aggregation script previously only looked for PR-number patterns
(`(#1234)`, `[#1234](url)`, `/pull/1234`). Since commit URL links use
`/commit/<sha>` (not `/pull/<N>`), the script found no candidates, logged
"No pending fragments found across referenced PRs", and exited without
injecting any rich release notes into the release PR body or GitHub Release.

The fix adds a secondary lookup path: extract all full commit SHAs from commit
URL links in the body, resolve each to its source PR(s) via the GitHub API, and
collect fragments from those PRs. This works for both the `update-pr` and
`update-release` modes. The direct PR-number path is still used when it
succeeds (no unnecessary API calls).

## Migration steps

No user migration required. The fix is purely internal to the CI release
pipeline. Future releases will automatically have rich release notes aggregated
from `docs/releases/pending/` fragments without any contributor action beyond
the existing convention of adding a pending fragment per PR.

## Known caveats

- The commit→PR API call (`GET /repos/.../commits/{sha}/pulls`) counts one REST
  request per commit SHA referenced in the release body. For typical releases
  with a handful of merged PRs, this is negligible. Very large releases with
  many commits in the body will generate more API calls but remain well within
  GitHub's rate limits for authenticated Actions tokens.
- If a commit is associated with more than one PR (cherry-pick or backport), all
  associated PRs are included and their fragments are collected. The
  de-duplication in `combineFragments` ensures no fragment appears twice.
