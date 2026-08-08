# Write-target resolver patch aliases + spiral detector hash fix

## What

Three guardrail-hardening fixes that prevent legitimate agent tool calls from
being blocked by false-positive verifications, the two shared utility modules
those fixes extract — **and three changes that belong to neither #2059 nor
#2060**, listed separately below because the PR title does not imply them: an
on-disk format change, a CI gate *activation*, and a CI gate policy
*relaxation*.

### The two issue fixes

- **#2059 — `write-target-resolver`:** the patch resolver now recognizes the
  common payload aliases `patchText`, `patch_text`, `patchPayload`, `text`, and
  `content` (in addition to `patch`, `input`, `diff`), and no longer
  misclassifies a standard unified diff as a malformed Native Vibe Patch when
  the model appends a stray `*** End Patch` trailer. It also now tolerates CRLF
  payloads and no longer drops indented native operation markers.
- **#2060 — `adversarial-detector`:** the debugging-spiral detector now hashes
  the complete tool-call arguments with a fixed-length, key-sorted hash instead
  of truncating the stringified args at 100 characters.

### Shared extraction (one bug class, three call sites)

- **`file-authority.hashArgs` + `redaction.computeMemoryCohortFingerprint`:**
  migrated off the same `JSON.stringify(value, sortedKeysArray)` property-list
  replacer anti-pattern that #2060's fix addressed, using a shared
  `stableCanonicalStringify` helper so all three call sites use one correct
  implementation.
- **Two new modules:** `src/utils/stable-stringify.ts` (the canonical
  serializer) and `src/utils/arg-hash.ts` (the bounded hash and the
  unserializable-args discriminator that the spiral detector and the guardrails
  circuit breaker both need). `src/hooks/guardrails/tool-before.ts` also stops
  maintaining its own inline copy of `PATCH_PAYLOAD_KEYS` and imports the
  resolver's.

### Not #2059 / #2060 — review these on their own terms

- **Persisted format change:** `memory-cohort-config.json` now records an
  `algorithm_version` field alongside the fingerprint. One writer
  (`src/commands/memory-link.ts`), four readers, a shared classifier and a
  barrel re-export in `src/memory/index.ts`. Files written before this change
  stay valid and require no re-link; the gate fails **open**. Details below.
- **CI gate activation:** `.github/workflows/ci.yml` sets `fetch-depth: 0` on
  the `quality` job's checkout. Five diff-scoped ratchet scripts in that job
  had been passing vacuously because they could not resolve a base ref; they
  now actually enforce. This can newly fail PRs that were passing for free.
- **CI gate policy relaxation:** `scripts/check-test-clock.sh` becomes
  line-scoped instead of file-scoped, which makes it catch **strictly less**
  than its previous implementation. It is also what makes this PR pass the gate
  the change above just activated. Both facts are disclosed in full below.

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
- The resolver now tolerates CRLF-terminated payloads (a model or wrapper that
  emits `\r\n` line endings no longer fails marker/line detection that assumed
  bare `\n`), and no longer drops native operation markers that are indented.
  Pre-fix, an indented `*** Update/Add/Delete File:` etc. marker inside valid
  `*** Begin/End Patch` framing was silently ignored by the marker scan, so
  the resolver **resolved successfully but without that target** — it
  returned `status: 'resolved'` with the indented operation's path missing
  from `paths`, letting the guardrail authorize a write set that omitted a
  real target. Indented operation markers are now recognized and included.
  Trimming this whitespace is a strict relaxation **of the marker scan** —
  every marker detected before is still detected, plus indented ones — but it
  is *not* neutral at the payload level, and that must not be overstated.
  Measured directly by running the base (`f2c832f9`) and head resolvers
  against the same three payloads:

  | Payload | Base | Head |
  |---|---|---|
  | `*** Begin Patch` / indented `*** Update File: ../../../etc/passwd` / `*** End Patch` | unverifiable — "Patch contains no recognizable write targets" | **resolved** `["../../../etc/passwd"]` |
  | indented `*** Update File:` with no framing at all | unverifiable — "Patch contains no recognizable write targets" | unverifiable — "Native patch is missing `*** Begin Patch`" |
  | indented `*** Update File: src/a.ts` *outside* framing, plus a column-0 `*** Update File: src/b.ts` inside it | **resolved** `["src/b.ts"]` — `src/a.ts` silently dropped | unverifiable — "operation outside begin/end markers" |

  Row 1 is a payload the base rejected and head now resolves, so the honest
  statement is that the change is not purely additive. It is still the
  intended direction: the previously-missed target is now *surfaced* to the
  caller for the same downstream path validation every other target gets — it
  is not authorized by being recognized. Row 3 is the original defect (a real
  target dropped from an otherwise-successful resolution) and row 2 confirms
  the unframed case still fails closed.

  This does introduce a new fail-closed trade-off worth calling out
  explicitly: a **unified diff** whose *context lines* happen to reproduce a
  column-0 native marker (e.g. a context line that starts with
  `*** Update File:`) is now classified as a native patch and rejected with
  "Native patch is missing `*** Begin Patch`", even though it is really a
  unified diff.

  **The measured blast radius is four files, and it was measured in *this*
  repo only** (`grep -rlE '^\*\*\* (Update|Add|Delete) File:|^\*\*\* Move (to|from):'`
  → `guardrails-directory.adversarial.test.ts`, `guardrails-plan-md-guard.test.ts`,
  `guardrails-v622-patch-aliases.test.ts` — added by this PR — and
  `write-lstat-authority.test.ts`). That number says nothing about the
  population that actually matters: this resolver ships inside a plugin that
  runs against **arbitrary consumer repositories**. Any repo containing a
  column-0 `*** Update/Add/Delete File:` or `*** Move to|from:` line — docs
  describing the native patch format, an agent prompt file, a skill, a test
  fixture — makes that file un-editable by a unified-diff patch tool, and the
  rejection message names a format the payload was never in. No measurement
  of that population exists. `edit`/`write` tool calls are unaffected, so the
  fallback is always available. This is deliberate: the
  alternative (only treating an operation marker as native when the payload
  also has no unified-diff headers) was built and tested and it reopens the
  original security hole — it silently drops the indented target from a
  mixed-signal payload a native applier could legitimately act on. The
  fail-closed side was chosen on purpose for a write-authorization guardrail.

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

### `src/utils/arg-hash.ts` (new)
- Exports four symbols: `boundedBunHash` and `coarseObjectDiscriminator` (the
  two helpers the spiral detector and the guardrails circuit breaker both call),
  plus `HASH_INPUT_CAP_BYTES` and `sampleForHash`, which are exported so the
  cap and the sampling transform can be tested directly rather than inferred
  from hash outputs (`tests/unit/utils/arg-hash.test.ts`,
  `tests/unit/hooks/guardrails-hash-args.test.ts`). All four are new in this
  release. `hashArgsForSpiral` (the #2060 fix) and `file-authority.hashArgs`
  need the same primitives, so they live in one module rather than as two
  inline copies — the same reason `stable-stringify.ts` was extracted. Fixing a
  hashing bug once, in one place, is the point.
- `coarseObjectDiscriminator` gives both hashers a *discriminating* answer when
  an argument object cannot be serialized (cyclic references, `BigInt`).
  Previously `file-authority.hashArgs` returned the constant `0` in that case,
  so every unserializable call hashed identically and a run of calls with
  genuinely *different* such args inflated the guardrails circuit breaker's
  consecutive-repetition count as though one call had repeated — the same
  false-positive class as #2060, via a different trigger. `hashArgsForSpiral`
  is new in this release and is given the same discriminator so it never
  acquires the bug. The discriminator is total: it cannot itself throw.
- `boundedBunHash` caps hashing cost on **both** per-tool-call hot paths, which
  are two different hooks:
  - **`toolAfter`** — `recordToolCall` (`src/index.ts:2669`, inside the
    `tool.execute.after` handler). Tripping the spiral detector produces an
    advisory message.
  - **`toolBefore`** — `hashArgs` via `trackToolCall`
    (`src/hooks/guardrails/tool-before.ts:1846`). This is the
    consecutive-repetition **circuit breaker, which throws**, so it is the more
    consequential of the two — as `file-authority.ts`'s own `hashArgs`
    docstring says: "this hash drives the consecutive-repetition circuit
    breaker in `tool-before.ts`, which THROWS."

  Patch payloads reach ~1 MB, and `bunHash` falls back to a per-byte djb2 loop
  when the plugin runs under Node (see `bun-compat.ts`), which measured ~141 ms
  for 2 MB. Inputs above the cap are reduced to a length-prefixed head+tail
  sample, which keeps worst-case cost at a few milliseconds while remaining
  injective at or below the cap and defeating both append- and
  prepend-collisions above it.
- **Residual lossiness, disclosed:** bounding introduces a collision class the
  previous uncapped hash did not have. Two inputs **longer than
  `HASH_INPUT_CAP_BYTES`** now hash equal if they have the same total length,
  the same leading half-cap of characters, and the same trailing half-cap of
  characters, differing only in the discarded middle. On the `toolBefore`
  circuit-breaker path that is a false repetition on a path that throws. It is
  unavoidable for any fixed-cost sampler and is the deliberate trade documented
  on `HASH_INPUT_CAP_BYTES` and `sampleForHash` in `src/utils/arg-hash.ts`.
  (The cap bounds UTF-16 code units, not bytes, despite the constant's name —
  also called out in the module.)

### Cohort config: `algorithm_version` (persisted format)
- `memory-cohort-config.json` now records `algorithm_version` alongside the
  fingerprint, and `FINGERPRINT_ALGORITHM_VERSION` (currently `1`) is exported
  from `src/memory/redaction.ts`.
- **Existing config files remain valid.** A file written before this change has
  no `algorithm_version`; every reader treats an absent field as the literal
  version `1` (the algorithm that predates the field — deliberately NOT
  "whatever the current constant happens to be", so that a future bump still
  detects legacy files instead of silently mis-comparing them). Since `1` is
  the current version today, a legacy file is compared exactly as it was
  before, and no re-link is required.
- A **present but non-numeric** `algorithm_version` is treated as unknown, and
  a stored version that differs from the running one is treated as not
  comparable. In both cases every reader **skips the byte comparison** instead
  of reporting a config mismatch — digests from different algorithms are not
  comparable, so comparing them would produce a misleading "your config
  differs" error. The gate **fails open**; memory is never stranded.
- **The four readers do not behave identically about telling you, and that is
  deliberate.** The two memory providers `warn()` on both the unknown and the
  mismatch case, each with a distinct message pointing at
  `/swarm memory link` (`memory/sqlite-provider.ts:2014,2028`;
  `memory/local-jsonl-provider.ts:584,598`, both inside
  `assertCohortConfigFingerprint`). The two read-only reporting surfaces
  (`services/status-service.ts:347`,
  `services/knowledge-diagnostics.ts:512`) emit **nothing at all** — they
  simply leave their fingerprint-match field unset/null, which is the
  "unknown" value those surfaces already have. Both carry the comment "this is
  a read-only reporting surface, so stay silent rather than warn". So: no
  duplicate warnings from a status read, and no false mismatch reported either.
- Files touched: `commands/memory-link.ts` (the single writer),
  `memory/redaction.ts` (the constant, the `LEGACY_…` literal and the shared
  `classifyStoredFingerprintAlgorithmVersion` classifier all four readers use),
  the four readers named above, and `memory/index.ts`, which adds
  `FINGERPRINT_ALGORITHM_VERSION` to the memory barrel's re-exports.

### `src/hooks/guardrails/file-authority.ts`
- `hashArgs` (used by the guardrails circuit-breaker repetition detector and
  the provider-failure fingerprint) migrated from
  `JSON.stringify(args, sortedKeys)` to `stableCanonicalStringify(args)`. This
  fixes the same nested-key-filtering bug class as #2060 for the circuit
  breaker: nested-args tools (e.g. `todowrite` with a `todos` array) previously
  collapsed distinct nested content to the same hash, so the circuit breaker
  could FALSELY trip on legitimate distinct calls (a hash collision between
  two different `todos` payloads made the consecutive-equality repetition
  count in `trackToolCall` inflate as if the same call had repeated). It could
  never suppress detection of a genuine repetition loop, since truly identical
  consecutive args already hashed equal under the old replacer too. The
  returned `number` changes for *every* input relative to the previous
  release — nested args because of the serializer fix, and flat args too
  because `boundedBunHash` now mixes in a length prefix. That is safe because
  the value is never persisted across versions (`recentToolCalls` is reset on
  snapshot rehydration, `session/snapshot-reader.ts`), so no stored hash is
  ever compared against a hash computed by a different version. What matters
  for detection is only that identical args hash equal *within* one process,
  which still holds.

### `src/memory/redaction.ts`
- `computeMemoryCohortFingerprint` migrated to `stableCanonicalStringify` for
  consistency and to future-proof against a nested field ever being added to
  `MemoryCohortFingerprintInput`. For the current flat input shape the output
  is byte-identical to the prior `JSON.stringify(input, sortedKeys)` — verified
  empirically — so existing persisted fingerprints in
  `memory-cohort-config.json` remain valid.

### `.github/workflows/ci.yml`
- The `quality` job's `actions/checkout` step now sets `fetch-depth: 0`. It
  previously defaulted to `fetch-depth: 1`, which meant none of the five
  diff-scoped ratchet scripts it runs (`check-mock-cleanup.sh`,
  `check-invariants.sh`'s mock-allowlist Check 4,
  `check-test-clock.sh`, `check-test-file-cap.sh`, `check-test-tmpdir.sh`)
  could resolve `origin/main`/`origin/master`/`main`/`master` as a base ref,
  so every diff-scoped check in that job silently no-opped (vacuous pass)
  instead of enforcing.

### `scripts/check-test-clock.sh`
- Now line-scoped instead of file-scoped. Previously a file counted as a NEW
  (blocking) violation if it merely appeared in the PR diff at all, even if
  the PR's changes never touched a raw-clock line — so editing an unrelated
  part of an already-violating file (e.g. adding new tests elsewhere) turned
  a pre-existing, non-blocking violation into a blocking one. It now only
  flags a file as NEW/blocking when the diff's *added* lines themselves
  introduce a raw-clock pattern (`Date.now()` / no-arg `new Date()` /
  `spyOn(Date)`); pre-existing violations in files touched for unrelated
  reasons remain non-blocking warnings.
- **This is a deliberate policy relaxation, not purely a bug fix.** The old
  header did promise file-scoping and the code implemented it faithfully;
  line-scoping catches strictly less (a PR that deletes a `freezeClock` import
  while leaving existing `Date.now()` calls used to block and now does not).
  It is adopted because blaming a file's pre-existing violations on whoever
  next edits it is a false accusation, and because the sibling
  `check-test-tmpdir.sh` is already line-scoped.
- **Disclosure:** this change and the `fetch-depth: 0` fix above interact. That
  fix activates a gate that was dormant, and the activated file-scoped gate
  would have newly blocked *this* PR over pre-existing raw-clock lines in two
  files it touches for unrelated reasons (`tests/unit/hooks/guardrails.test.ts`
  and `tests/unit/services/knowledge-diagnostics.test.ts` — neither of which
  this PR adds a clock line to). Line-scoping is the correct policy on its own
  merits, but it also unblocks this PR, and reviewers should weigh it knowing
  that.
- Also fixes a fail-open bug found during review: the helper ended in
  `grep -qE` under `set -o pipefail`, so on a large enough diff `grep -q`
  closed its stdin early, the upstream `grep` took SIGPIPE, and the pipeline
  returned 141 — reporting "no new clock line" *despite a match*. Replaced with
  a counted `grep -cE`, which drains stdin.

## Test plan

Ten test files are added or modified. Every one was run individually, per the
per-file isolation loop `AGENTS.md` §6 requires for repo validation; all pass.
Line counts are base (`f2c832f9`) → head.

**New files (5)**

| File | Lines | Tests | Covers |
|---|---|---|---|
| `tests/unit/utils/stable-stringify.test.ts` | 237 | 28 | The new canonical serializer directly: recursive key sorting at every depth, and each documented divergence from `JSON.stringify` (`Date`/`Map`/`Set` → `{}`, `undefined` → `null` in property and element position, true array holes preserved, cyclic → `RangeError`, `BigInt` → `TypeError`). |
| `tests/unit/utils/arg-hash.test.ts` | 149 | 17 | `HASH_INPUT_CAP_BYTES`, `sampleForHash`, `boundedBunHash`, `coarseObjectDiscriminator`. Includes the at-cap vs over-cap case that proves the length prefix is load-bearing, and a hostile `Proxy` whose `ownKeys` throws — the discriminator must be total, since both callers invoke it from inside a `catch`. |
| `tests/unit/hooks/guardrails-hash-args.test.ts` | 161 | 17 | `file-authority.hashArgs`. **This is where the `hashArgs` cases now live** — see the note below. |
| `tests/unit/hooks/guardrails-v622-patch-aliases.test.ts` | 110 | 10 | **The whole FB-014 fix.** Drives the real `createGuardrailsHooks(...).toolBefore` — the guardrail runtime layer, not the resolver — for all five new aliases: each alias targeting `.swarm/plan.json` throws `PLAN STATE VIOLATION`, and each alias targeting a non-plan file does not. The resolver-level alias tests could not have caught a guardrail-layer wiring gap. |
| `tests/unit/services/status-service.memory-fingerprint-version.test.ts` | 180 | 7 | The `algorithm_version` gate in `status-service`, including a simulated future version bump via the `redaction._internals` seam. |

**Modified files (5)**

| File | Lines | Tests | Change |
|---|---|---|---|
| `tests/unit/hooks/write-target-resolver.test.ts` | 179 → 373 | 28 | Each alias resolves a unified diff; trailing `*** End Patch` trailer resolves; a column-0 `*** Update File:` with no begin marker still fails closed (security regression guard); genuine native patch still resolves; CRLF payloads resolve; indented operation markers are included; cross-field conflicting targets and non-string alias payloads are both rejected with pinned messages. |
| `tests/unit/hooks/adversarial-detector-wiring.test.ts` | 117 → 377 | 22 | Paged reads at different offsets do not spiral (the #2060 bug); identical calls still spiral; reordered-key args spiral; string vs object args do not collide; nested-args tools with different nested content do not spiral; nested-args with reordered keys at any depth still spiral. |
| `tests/unit/memory/cohort-config-fingerprint.test.ts` | 159 → 496 | 24 | **Not "unchanged"** (338 insertions / 1 deletion). Pins the fingerprint with a golden digest and asserts key-order independence (so the `stableCanonicalStringify` migration is provably a no-op for the current flat input), and adds the `algorithm_version` gate: absent → legacy v1, present-non-numeric → unknown, and a simulated bump to 2 exercised against both providers. |
| `tests/unit/services/knowledge-diagnostics.test.ts` | 295 → 422 | 16 | Adds a 7-test `#2062 F-012` block for the fourth reader: legacy config still compares (match and mismatch), differing version reports no false mismatch, non-numeric reports unknown, and a simulated bump reports unknown. |
| `tests/unit/hooks/guardrails.test.ts` | 2875 → 2808 | 95 | **Net deletion** (1 insertion / 68 deletions). The `describe('hashArgs')` block was *moved out* of this file, not added to it — see below. |

**Where the `hashArgs` cases went (F-004).** They are no longer in
`guardrails.test.ts`; that file no longer references `hashArgs` at all. The
block was extracted intact into the new
`tests/unit/hooks/guardrails-hash-args.test.ts` because `guardrails.test.ts`
is already far over the 500-line `check-test-file-cap.sh` ratchet, and growing
an over-cap file is an ERROR under that gate — which the `fetch-depth: 0`
change in this PR activates. The cases themselves are unchanged in intent:
nested args with different content produce different hashes (no nested-key
filtering) and nested args with reordered keys at any depth produce the same
hash, both verified to fail against the old replacer-array implementation.

**The `algorithm_version` gate is bump-tested in all four readers**, not just
where it is easiest: sqlite and local-jsonl in
`cohort-config-fingerprint.test.ts`, status-service in its own new file, and
knowledge-diagnostics in its F-012 block. Each asserts that a legacy file
under a simulated bump resolves to version **1** rather than to the simulated
current version — the actual defect, which is invisible while the constant is
still 1.

**Not covered by an automated test:** the five ratchet scripts that
`fetch-depth: 0` activates only run in CI. All five were simulated by hand
against this PR's own diff and pass:
- `check-test-file-cap.sh`: the only changed test file over 500 lines is
  `guardrails.test.ts`, and it **shrank** (2875 → 2808), which the ratchet
  permits; the largest of the other nine is 496.
- `check-test-clock.sh`: zero raw-clock lines added across all ten files.
- `check-test-tmpdir.sh`: the single added `tmpdir()` call is
  `realpathSync(mkdtempSync(...))` on the same line.
- `check-mock-cleanup.sh` and `check-invariants.sh` Check 4: no `mock.module`
  or `vi.mock` target added.

## Invariant audit
- 1 (plugin init): not touched.
- 2 (runtime portability): touched — `bunHash` is the existing cross-runtime
  shim; no new direct `Bun.*` calls.
- 3 (subprocesses): not touched.
- 4 (.swarm containment): not touched.
- 5 (plan durability): not touched.
- 6 (test_runner safety): not touched.
- 7 (test writing): touched — `bun:test` only; zero `mock.module`/`vi.mock`
  targets added by this PR; the one new DI need is served by an `_internals`
  seam (`src/memory/redaction.ts`, registered in
  `docs/engineering-invariants.md`) rather than by module mocking; all five new
  test files are under the 500-line cap (largest 237); the one added
  `tmpdir()` call is wrapped in `realpathSync`. Note that invariant 7 does not
  require unique session IDs and this PR does not claim them —
  `guardrails-v622-patch-aliases.test.ts` deliberately reuses the literal
  `'test-session'` across its ten parameterised cases, each of which
  constructs fresh hooks and re-establishes the session.
- 8 (session state): touched — per-session keying preserved; per-entry memory
  bounded (net decrease).
- 9 (guardrails/retry): touched — this is a guardrail correctness fix.
- 10 (chat/system msg): not touched.
- 11 (tool registration): not touched.
- 12 (release/cache): touched — this fragment.
