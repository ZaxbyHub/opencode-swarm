# Write-target resolver patch aliases + spiral detector hash fix

## What

Three independent guardrail-hardening fixes that prevent legitimate agent tool
calls from being blocked by false-positive verifications, plus a shared stable
serialization helper that eliminates a class of nested-key-filtering bugs
across the codebase.

- **#2059 — `write-target-resolver`:** the patch resolver now recognizes the
  common payload aliases `patchText`, `patch_text`, `patchPayload`, `text`, and
  `content` (in addition to `patch`, `input`, `diff`), and no longer
  misclassifies a standard unified diff as a malformed Native Vibe Patch when
  the model appends a stray `*** End Patch` trailer.
- **#2060 — `adversarial-detector`:** the debugging-spiral detector now hashes
  the complete tool-call arguments with a fixed-length, key-sorted hash instead
  of truncating the stringified args at 100 characters.
- **`file-authority.hashArgs` + `redaction.computeMemoryCohortFingerprint`:**
  migrated off the same `JSON.stringify(value, sortedKeysArray)` property-list
  replacer anti-pattern that #2060's fix addressed, using a shared
  `stableCanonicalStringify` helper so all three call sites use one correct
  implementation.

## Why

### #2059
Models and tool wrappers frequently emit patch content under alternative field
names. The resolver's narrow `PATCH_PAYLOAD_KEYS` list rejected them with
`WRITE TARGET UNVERIFIABLE: No patch payload was provided`, blocking valid
patches. Separately, a standard unified diff that happened to end with
`*** End Patch` (or included a `*** Update File:` line) was misclassified as a
Native Vibe Patch and rejected with `Native patch is missing *** Begin Patch`,
because any native marker triggered native classification.

### #2060
`recordToolCall()` truncated its argument hash at 100 characters via
`.slice(0, 100)`. For paged `read` calls on a long file path, the differing
`offset` value sat past character 100 and was sliced off, so five legitimate
calls on different offsets produced identical hashes and triggered a
false-positive `debugging_spiral_detected` event with an advisory hard-stop
message.

## Changes

### `src/hooks/write-target-resolver.ts`
- `PATCH_PAYLOAD_KEYS` expanded to include the five aliases and **exported** so
  the guardrail layer reuses one source of truth (the same list had drifted
  into three copies).
- Native classification now requires a `*** Begin Patch` marker, OR any native
  operation marker (`*** Update/Add/Delete File:`, `*** Move to|from:` — these
  are unambiguous native syntax and always demand framing), OR a bare
  `*** End Patch` marker with no unified-diff headers. A stray `*** End Patch`
  trailer on a unified diff is now tolerated; operation markers without a begin
  marker still fail closed (security guard preserved).

### `src/hooks/guardrails/tool-before.ts`
- `extractAllPatchPayloads` and `extractPatchTargetPaths` now import
  `PATCH_PAYLOAD_KEYS` from `write-target-resolver` instead of maintaining
  inline copies. Historical precedence (`input ?? patch ?? diff ?? cmd[1]`) is
  preserved.

### `src/hooks/adversarial-detector.ts`
- `recordToolCall()` now uses a new `hashArgsForSpiral()` helper that produces
  a fixed-length hash via `bunHash()` (the existing cross-runtime shim: xxHash64
  on Bun, djb2 on Node). Object keys are sorted recursively at every depth via
  the shared `stableCanonicalStringify` helper (not a `JSON.stringify`
  property-list replacer, which would silently drop nested keys and
  re-introduce collisions for nested-args tools like `todowrite`). Strings
  above 64 chars are hashed too, keeping per-entry memory bounded (net decrease
  vs. the old 100-char ceiling). `SPIRAL_THRESHOLD` (5) is unchanged — the fix
  is in the hash, not the threshold.

### `src/utils/stable-stringify.ts` (new)
- Exports `stableCanonicalStringify`, a recursive canonical JSON serializer
  that sorts object keys at every depth without filtering (unlike a
  `JSON.stringify` property-list replacer, which filters keys at nested
  depths). Shared by `hashArgsForSpiral`, `hashArgs`, and
  `computeMemoryCohortFingerprint` so all three use one correct implementation.

### `src/hooks/guardrails/file-authority.ts`
- `hashArgs` (used by the guardrails circuit-breaker repetition detector and
  the provider-failure fingerprint) migrated from
  `JSON.stringify(args, sortedKeys)` to `stableCanonicalStringify(args)`. This
  fixes the same nested-key-filtering bug class as #2060 for the circuit
  breaker: nested-args tools (e.g. `todowrite` with a `todos` array) previously
  collapsed distinct nested content to the same hash, so a genuine repetition
  loop on a nested-args tool could be missed. The returned `number` is
  unchanged for flat args (the common case) and only differs for nested args
  (the fix). The value is never persisted across versions
  (`recentToolCalls` is reset on snapshot rehydration), so there is no
  cross-version comparison risk.

### `src/memory/redaction.ts`
- `computeMemoryCohortFingerprint` migrated to `stableCanonicalStringify` for
  consistency and to future-proof against a nested field ever being added to
  `MemoryCohortFingerprintInput`. For the current flat input shape the output
  is byte-identical to the prior `JSON.stringify(input, sortedKeys)` — verified
  empirically — so existing persisted fingerprints in
  `memory-cohort-config.json` remain valid.

## Test plan
- New `write-target-resolver.test.ts` cases: each alias resolves a unified
  diff; trailing `*** End Patch` trailer resolves; stray `*** Update File:`
  without begin still fails closed (security regression guard); genuine native
  patch still resolves.
- New `adversarial-detector-wiring.test.ts` cases: paged reads with different
  offsets do not spiral (the bug); identical calls still spiral; reordered-key
  args spiral (correctness); string vs object args do not collide; nested-args
  tools with different nested content do not spiral; nested-args with reordered
  keys at any depth still spiral.
- New `guardrails.test.ts` cases for `hashArgs`: nested args with different
  content produce different hashes (no nested-key filtering); nested args with
  reordered keys at any depth produce the same hash. Both verified to fail
  against the old replacer-array code.
- `cohort-config-fingerprint.test.ts` passes unchanged (redaction.ts migration
  is a no-op for the current flat input — verified byte-identical).
- All existing write-target, scope-guard, guardrails, and adversarial-detector
  tests pass unchanged.

## Invariant audit
- 1 (plugin init): not touched.
- 2 (runtime portability): touched — `bunHash` is the existing cross-runtime
  shim; no new direct `Bun.*` calls.
- 3 (subprocesses): not touched.
- 4 (.swarm containment): not touched.
- 5 (plan durability): not touched.
- 6 (test_runner safety): not touched.
- 7 (test writing): touched — `bun:test`, no `mock.module`, direct function
  calls, unique session IDs.
- 8 (session state): touched — per-session keying preserved; per-entry memory
  bounded (net decrease).
- 9 (guardrails/retry): touched — this is a guardrail correctness fix.
- 10 (chat/system msg): not touched.
- 11 (tool registration): not touched.
- 12 (release/cache): touched — this fragment.
