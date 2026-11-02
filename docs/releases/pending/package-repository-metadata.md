---
issue: 3227
---

# Package manifests now declare their repository

## What

All four publishable package manifests (`packages/{opencode,core,claude-code,telemetry}/package.json`) carry a `repository` field pointing at `ZaxbyHub/opencode-swarm` with their monorepo `directory`. `opencode` previously pointed at the pre-transfer `zaxbysauce` owner; the other three had no repository field at all.

## Why

npm's OIDC trusted publishing enables a provenance attestation on every publish, and the registry validates that the attestation's repository matches the manifest's `repository.url`. A missing or stale repository field makes every `next`-channel publish fail with `422 Unprocessable Entity - Failed to validate repository information` — which is exactly what blocked the 8.0.2-beta.0 healing release. This also completes the post-transfer metadata move for the scoped packages ahead of the default-branch reunification.
