---
issue: 3548
---

# npm publish failure diagnostics on the 8.x release pipeline

## What

When an `npm publish` step in the `release-please-next` workflow fails, the workflow now dumps the last 120 lines of npm's debug log into the Actions output before failing. No publish semantics change: the fail-loud exit, the `FORCE_PUBLISH` version-conflict tolerance, and the publish order are untouched.

## Why

npm's OIDC exchange fails silently by design (verbose-only logging) and falls back to token auth, so when trusted-publisher configuration doesn't match — or the token lacks package scope — the visible error is the fallback path's and the actual cause is invisible. The first 8.0.2-beta.0 publish attempt blocked on exactly this. The debug dump names the failing mechanism directly.
