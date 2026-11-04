---
issue: 3501
---

# Dependency-bump channel + release-pipeline integrity

## What

- **Dependency-bump channel (route (a), #3501/#3285):** a `workflow_dispatch`-gated `github-actions[bot]` channel (`.github/workflows/dependency-bump.yml`) that bumps one dependency, applies bounded pin replacements (`scripts/apply-dep-bump-pins.mjs`), optionally regenerates config-schema artifacts, verifies fail-closed (non-empty 1..8 tracked suites, plus typecheck for source-affecting dispatches), enforces a complete-diff allowlist around the verify step, and pushes exactly one bot-authored commit with `X-Dep-Bump-*` provenance trailers to a collision-safe `dep-bump--<pkg>--<hash8>` branch, opening or refreshing the PR with `GH_TOKEN` + `gh auth setup-git`. The release-owner guard (`scripts/check-required-check-contract.ts`) gains the matching authorization arm: `DEPENDENCY_BUMP_AUTOMATION_EXCEPTION`, bound to package.json-only owner edits, every-commit bot provenance with the trailer set (advisory XOR reason), a type-sensitive semantic scope check that only the `dependencies`/`devDependencies` maps may differ (version-field and scripts laundering denied), and a merge-group arm keyed on the merge subject + bot second parent. Security bumps that must carry test re-derivation in the same PR (the zod 4.6.7 HIGH GHSA-mrhx-c7xc-m3w5 bump) now have a legal landing path; the bot PR's `action_required` CI runs need one write-user approval before queueing.
- **#3527 ORDER-1:** the `cleanup-release-fragments` job checks out the release tag instead of `main`, so `validateExactTagProof` never sees a drifted HEAD — release archives no longer strand when main advances between tag and cleanup (the #3500 class).
- **#3527 CRED-1:** `persist-credentials: false` on the three tag-ref checkouts of `release-and-publish.yml`.
- **#3501 AC2 enabler (third path, critic-verified):** `pricing.effective_at` pins its optional-seconds datetime contract explicitly (`EFFECTIVE_AT_DATETIME_PATTERN` shared by runtime schema and generator normalization), so the zod 4.6 bump (whose `.datetime()` tightens to required seconds) cannot silently change public validation semantics; the generated artifact stays byte-identical under zod 4.3.6.

## Why

Issues #3501 (zod HIGH, no legal bump path), #3285 (fast-check declaration blocked by the same wall), #3527 (release-archive stranding race + credential hygiene). The AC3 route-(a) decision is recorded on #3501 (comment 6637732864); the zod 4.6.7 bump itself lands as a channel-dispatched bot PR after this PR merges (the guard evaluates the protected base revision's checker), and fast-check follows the same channel.
