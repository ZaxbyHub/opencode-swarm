# Adopt identifier-preserving minification for the main bundle

## What changed

The main plugin bundle (`dist/index.js`) is now built with `--minify-whitespace --minify-syntax`. This is the identifier-preserving minification variant — function, variable, and class names remain intact in the shipped artifact.

Measured result (experimental, Windows local):
- Unminified: ~5.77 MiB
- Minified: **4,480,989 bytes** (~4.48 MiB)
- Savings: **~1.28 MiB (~22.3%)**

Final CI-built figures may differ by ~2 KB across platforms/toolchains; the smoke cap is tightened to the new minified baseline in #1582's companion task.

## Why this variant

Full minification (`--minify`, which also mangles identifiers) was evaluated and rejected by General Council (2 rounds, generalist / domain_expert / skeptic). It breaks 13 identifier-grepping guardrail assertions in `tests/unit/build/full-auto-toolbefore-fail-closed.test.ts` and `tests/unit/turbo/lean/runtime-conformance.test.ts`, and mangles user-reported stack traces. Source maps were ruled out as non-viable: the plugin has no error-service pipeline, users cannot be assumed to run Node with `--enable-source-maps`, and the ~4× map-size tax would erase the savings.

Identifier-preserving minification (`--minify-whitespace --minify-syntax`) retains human-readable names in stack traces without requiring source maps, while still delivering the measured size reduction.

## Why now

The unminified bundle had reached its smoke cap (6.5 MiB), triggering repeated cap bumps (5 → 5.5 → 6.5 MiB) and merge-queue flakes from ~2 KB cross-platform build variance. Minification bends the size curve; the cap is re-tightened to the new minified baseline so future growth remains visible in CI.

## Migration steps

None. The build flag change is transparent to consumers. `dist/index.js` remains a single Node-ESM-loadable file (invariant 2).

## Known caveats

- Cross-platform build variance of ~2 KB still applies; the smoke cap accounts for this band.
- Stack traces remain fully triageable without source maps because identifier names are preserved.
