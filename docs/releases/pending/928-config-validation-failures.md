# Config test alignment for agent registry and quiet/symlink behavior

## What

- Updated `tests/unit/config/constants.test.ts` and
  `tests/unit/config/critic-registration.test.ts` to match the current agent
  registry and default model assignments (`docs_design`,
  `critic_hallucination_verifier`, and `critic_sounding_board` model).
- Updated `tests/unit/config/quiet-config.test.ts` to use a supported embedded
  variant token (`/high`) so quiet/deprecation assertions validate the live
  behavior.
- Hardened `writeProjectConfigIfNew` to refuse writes when `.opencode` resolves
  through a symlink/junction path, and extended `project-init` coverage for that
  path.
- Fixed a false-positive in the symlink guard: when the project root directory
  itself traverses a symlink (e.g. macOS `/tmp` → `/private/tmp`), the guard
  now correctly compares against the canonicalized parent path instead of the
  unresolved string, preventing silent write failures in those environments.

## Why

The config directory batch contained stale expectation drift plus a Windows-path
symlink/junction edge case. These changes align tests with source-of-truth
registry/model behavior and tighten `.opencode` write safety.

## Migration

No migration required.

## Caveats

- `bun --smol test tests/unit/config --timeout 120000` still has unrelated,
  pre-existing failures in legacy automation compatibility tests (also present on
  clean `origin/main` in this environment).
