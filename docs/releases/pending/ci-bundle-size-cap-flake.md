# CI: Raise main-bundle smoke cap to 6.5 MiB to fix a merge-queue flake

## What changed

`MAIN_BUNDLE_MAX_BYTES` in `tests/smoke/packaging.test.ts` is raised from 5.5 MiB to 6.5 MiB.

- The smoke test `dist/index.js file size is reasonable` now allows up to 6.5 MiB (was 5.5 MiB).
- The accompanying comment documents the bump history (5 → 5.5 → 6.5 MiB), the cross-platform build variance that caused the flake, and points to the minify investigation in #1582.

## Why

The unminified `dist/index.js` bundle had grown to sit ~1 KB below the 5.5 MiB cap. Builds are deterministic per platform but vary ~2 KB across platforms/toolchains (Windows local ≈ 5,766,141 B — under; Linux CI ≈ 5,768,289 B — over). So the smoke size assertion flipped pass/fail depending on the runner, intermittently failing on `merge_group` and blocking the merge queue for unrelated PRs (observed on PR #1579's first queue attempt and on PR #1560).

A sub-10 KB trim would not help — the overage (~1–2 KB) is within build-environment variance, so any small reduction would re-flake on the next dependency bump. Raising the cap to 6.5 MiB restores ~1 MiB of headroom (well above the variance) while staying tight enough to keep genuine bundle growth visible in smoke CI. This mirrors the project's precedented cap-bump convention (main 5 → 5.5; CLI 1 → 2 → 2.2 → 2.4).

The structural alternative — minifying the main bundle, which measures ~43% smaller (5.50 → 3.13 MiB) with all bundle and smoke tests passing — is deferred to #1582 because it changes the distributed artifact (stack-trace debuggability for a plugin that runs in users' environments) and warrants its own decision.

## Migration steps

None. Test-only change.

## Known caveats

- This raises a tripwire rather than reducing the bundle; the bundle will eventually approach 6.5 MiB and need either another bump or the minify path in #1582.
- The smoke size gate runs on `merge_group` (and PR smoke); it is OS-sensitive by ~2 KB, so the cap is intentionally kept comfortably above the observed build-variance band rather than at the bundle's exact size.
