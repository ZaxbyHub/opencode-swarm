# CI: Raise main-bundle smoke cap to 8.0 MiB

## What changed

`MAIN_BUNDLE_MAX_BYTES` in `tests/smoke/packaging.test.ts` is raised from 7.5 MiB to 8.0 MiB.

The packaging smoke test remains active and still asserts that the shipped main bundle is non-empty and below the cap.

## Why

The issue #1824 integrity-boundary implementation adds intentionally always-on sandbox, guardrail, and approval-integrity code. After those changes, the identifier-preserving build is approximately 7.5 MiB and exceeded the 7.5 MiB merge-queue tripwire on Ubuntu and Windows smoke jobs. The build already uses `--minify-whitespace --minify-syntax`; 8.0 MiB restores meaningful headroom while keeping a strict regression detector.

## Migration steps

None. This changes only the packaging smoke threshold; the published plugin format and runtime behavior are unchanged.
