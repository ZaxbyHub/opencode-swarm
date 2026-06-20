# npm: Fix repository URL for sigstore provenance verification

## What changed

Updated `package.json` `repository.url` from `https://github.com/zaxbysauce/opencode-swarm.git` to `https://github.com/ZaxbyHub/opencode-swarm.git` to match the repository's current location after the org move.

## Why

npm's `--provenance` flag performs sigstore verification that requires the `repository.url` in `package.json` to exactly match the GitHub repository running the workflow. After the repository moved from `zaxbysauce` to `ZaxbyHub`, the stale URL caused:

```
npm error 422 Unprocessable Entity
Error verifying sigstore provenance bundle: package.json repository.url
is git+https://github.com/zaxbysauce/opencode-swarm.git, expected to match
https://github.com/ZaxbyHub/opencode-swarm from provenance
```

GitHub's redirect masked this for non-provenance operations, but the sigstore check is stricter.
