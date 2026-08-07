# Write-target resolver patch aliases + spiral detector hash fix

## What

Two independent guardrail-hardening fixes that prevent legitimate agent tool
calls from being blocked by false-positive verifications.

- **#2059 — `write-target-resolver`:** the patch resolver now recognizes the
  common payload aliases `patchText`, `patch_text`, `patchPayload`, `text`, and
  `content` (in addition to `patch`, `input`, `diff`), and no longer
  misclassifies a standard unified diff as a malformed Native Vibe Patch when
  the model appends a stray `*** End Patch` trailer.
- **#2060 — `adversarial-detector`:** the debugging-spiral detector now hashes
  the complete tool-call arguments with a fixed-length, key-sorted hash instead
  of truncating the stringified args at 100 characters.

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
  a dedicated `stableCanonicalStringify` helper (not a `JSON.stringify`
  property-list replacer, which would silently drop nested keys and
  re-introduce collisions for nested-args tools like `todowrite`). Strings
  above 64 chars are hashed too, keeping per-entry memory bounded (net decrease
  vs. the old 100-char ceiling). `SPIRAL_THRESHOLD` (5) is unchanged — the fix
  is in the hash, not the threshold.

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
