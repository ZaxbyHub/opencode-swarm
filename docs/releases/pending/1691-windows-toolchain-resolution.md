---
title: Windows toolchain spawn resolution
issue: 1691
---

## What changed

On Windows, `isCommandAvailable` and `findBinaryInPath` only checked for `.exe` extensions. npm-distributed tools (eslint, biome, tsc, ruff) install as `.cmd` shims on Windows, so they were reported as unavailable. This caused Stage-A quality checks to silently degrade on Windows.

## Fix

- `isCommandAvailable`: removed `.exe` suffix from `where` search — Windows `where` uses PATHEXT to find `.cmd`, `.bat`, `.exe`, `.ps1` automatically
- `findBinaryInPath`: now checks `.exe`, `.cmd`, `.bat`, and bare name on Windows

## Acceptance

A Windows environment with npm-distributed tooling (`.cmd` shims) now correctly reports those tools as available for Stage-A quality checks.
