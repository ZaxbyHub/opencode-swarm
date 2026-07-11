# SAST dead-code cleanup (issue #1654)

## What changed

- **`src/sast/rules/index.ts` ΓÇö `SastRule` interface:** Removed `query?: string` optional field.
  No rule implementation ever populated this field.

- **`src/sast/rules/index.ts` ΓÇö `SastContext` interface:** Removed `parser?: unknown` and `tree?: unknown`
  optional fields. Neither field was ever populated by any caller.

- **`src/sast/rules/index.ts`:** Deleted the `executeRules()` async wrapper function.
  `sast-scan.ts` imports `executeRulesSync` directly; the async wrapper had zero external consumers.

- **`src/sast/rules/index.ts`:** Removed `executeRules` from the `_internals` type signature and value object.

- **`src/sast/rules/index.ts`:** Updated a comment from "Detection: either query OR pattern" to
  "Detection: regex pattern" to reflect actual behavior.

## Why

The SAST rule infrastructure accumulated fields and a wrapper function that were never used by any
rule implementation. Audit confirmed zero in-tree or external consumers. Removing this dead code
reduces interface surface area and eliminates maintenance overhead with no impact on SAST rule
matching behavior. Net change: +1/-20 lines.

## Migration

No migration required.

## Known caveats

None.
