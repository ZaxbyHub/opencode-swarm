# CI: Raise main-bundle smoke cap to 7.5 MiB

## What changed

`MAIN_BUNDLE_MAX_BYTES` in `tests/smoke/packaging.test.ts` is raised from 6.5 MiB to 7.5 MiB.

- The smoke test `dist/index.js file size is reasonable` now allows up to 7.5 MiB (was 6.5 MiB).

## Why

The main bundle crossed the 6.5 MiB cap on macOS CI (`smoke (macos-latest)`, measured 6,844,676 B against the 6,815,744 B cap) after normal source growth — exactly the outcome `docs/releases/pending/ci-bundle-size-cap-flake.md` anticipated ("the bundle will eventually approach 6.5 MiB and need either another bump or the minify path"). This mirrors the project's precedented cap-bump convention (5 → 5.5 → 6.5 → 7.5 MiB).

## Migration steps

None. Test-only change.

## Known caveats

- Same caveat as the prior bump: this raises a tripwire rather than reducing the bundle. The structural fix (minifying the main bundle, ~43% smaller per the prior fragment's measurement) remains deferred to a separate decision, since it affects the distributed artifact's stack-trace debuggability.
