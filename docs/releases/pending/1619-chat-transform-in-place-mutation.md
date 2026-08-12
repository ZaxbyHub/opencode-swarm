# Chat-transform hooks now mutate in place — system-message consolidation actually runs

## What

The OpenCode host invokes each plugin hook as `M(input, output)`, **discards the
handler's return value**, and afterwards reads its own local array (`Plugin.trigger`,
host binary offset ~102,127,180: `yield* v.promise(async () => M(K, U))`, with `U`
returned unchanged). Reassigning `output.system` / `output.messages` inside
`experimental.chat.system.transform` or `experimental.chat.messages.transform` is
therefore invisible to the host.

Three **consequential** rebinds were doing exactly that:

- The final `messages.transform` handler ran
  `output.messages = consolidateSystemMessages(output.messages)`. The
  consolidation the docs and AGENTS.md invariant 10 both described had **never
  taken effect**. It now runs, via a new `consolidateSystemMessagesInPlace`.
- The dead `output.system` collapse handler (added for Qwen3.6/Gemma
  compatibility in `#628`) has been removed rather than activated — the host
  marks prompt-cache breakpoints on the first two system messages (host binary
  ~102,133,558, `function nk($,Z){let Q=$.filter(X=>X.role==="system").slice(0,2)…
  cacheControl:{type:"ephemeral"}}`), so folding the stable base prompt into the
  per-request swarm injections would defeat prompt caching on every request.
- The durable-background-advisory rollback path restored `output.messages` by
  rebinding, which redirected only the later handlers in the composed chain
  while the model still received the half-inserted advisories. It now restores
  in place **when the host-supplied array is present**.

A fourth instance was on `main` when this change was written: the role-scoped
system filter (`src/context/role-filter.ts`) ended its `system.transform` handler
with `output.system = filtered.map(…)`, so the role filtering it exists to
perform would never have reached the model. It now clears and refills the
host-supplied array in place.

Two further assignment sites match the same syntactic pattern and are
deliberately kept, so the guard's allowlist covers **three occurrences across
two records**, not the one an earlier draft of this note implied:

- `src/index.ts` × 2 — `createSwarmCommandSystemRuleHook` does
  `const system = Array.isArray(output.system) ? output.system : []` and then
  assigns `output.system = system`. Against the host these are self-assignments
  the host never observes (the rule reaches the model through the in-place
  `system.push(...)`); for non-host callers and tests, where `output.system` is
  absent, the assignment is the only thing that attaches the fresh local.
- `src/index.ts` × 1 — the `else` arm of the durable-background-advisory
  rollback above. The `if` arm restores in place and is the production path;
  the `else` arm is reached only when `output.messages` is absent or not an
  array, where there is no host-owned array to mutate and dropping the
  assignment would silently skip the rollback for non-host callers and tests.

Guards added:

- a source scan (`tests/unit/hooks/chat-transform-rebind-guard.test.ts`) that
  fails on any un-allowlisted `.system` / `.messages` assignment in `src/`,
  covering both dot access (`output.messages = x`) and quoted computed access
  (`output['messages'] = x`);
- a behavioural suite
  (`tests/unit/hooks/system-message-consolidation-in-place.test.ts`) that pins
  the consolidation semantics and its interaction with **two** of the hooks that
  splice a system message into the live history — knowledge injection and memory
  recall — plus a combined case. It does *not* cover the other splicing modules
  (`src/hooks/delegation-gate.ts`, `src/hooks/guardrails/messages-transform.ts`,
  `src/hooks/issue-trace.ts`, `src/hooks/full-auto-intercept.ts`);
- a composed-chain test
  (`tests/unit/hooks/chat-transform-composed-chain-in-place.test.ts`) that boots
  the real plugin and drives the registered
  `experimental.chat.messages.transform` handler array while holding the
  caller's original array reference — the only test that can tell a rebind apart
  from an in-place mutation **in the production wiring**.

`AGENTS.md` invariant 10, `docs/engineering-invariants.md` (v6.85.1) and
`docs/context-map.md` have been corrected — they documented a mechanism that
never executed. Invariant 10's reference was also repointed from `#608` (the
issue that *asked* for a single system prompt) to `#628` (the PR that shipped
the `output.system` collapse, and therefore the thing being described as dead).

## Also in this change: `.swarm/` artifact writers now invalidate the read cache

`readSwarmFileAsync` — and the four cached readers it wraps
(`readCachedTextFile(Sync)` / `readCachedParsedFile(Sync)`) — route every
`.swarm/` read through the swarm-artifact cache, which decides freshness from a
stat stamp alone (mtime + ctime + size). A same-size rewrite landing inside one
filesystem timestamp tick produces an identical stamp, so the next
read-your-own-write can silently return the pre-write value (issue #1729).

The bounded, machine-checked claim: **every writer that a static scan of `src/`
can resolve to a cached artifact now calls `invalidateCachedArtifact` after a
**successful** write, and every cached-reader call site whose path argument the
scan cannot resolve is enumerated — with a stated reason — in a test-enforced
registry (6 entries, listed below).** The scan is
`tests/helpers/swarm-write-cache-scan.ts`; it asserts
`resolved + registered == total reader call sites`, so a reader it cannot see
fails CI instead of silently shrinking the guard's blast radius. That identity,
not the writer table, is what makes the claim checkable — the previous wording
("every writer of a path that some reader consumes through that cache") was an
absolute that four consecutive review rounds each falsified with one more
missed writer.

| Artifact | Writer |
| --- | --- |
| `plan.json`, `plan.md` | `src/plan/manager.ts` (4 functions: `regeneratePlanMarkdown`, `savePlan`, `rebuildPlan`, `closePlanTerminalState`) |
| `spec-staleness.json` | `src/plan/manager.ts` (`loadPlan`'s spec-drift marker write) |
| `context.md` | `src/commands/close.ts`, `src/hooks/agent-activity.ts` (via `atomicWriteFile`), `src/hooks/skill-propagation-gate.ts` |
| `handoff.md` | `src/commands/handoff.ts` |
| `session/state.json` | `src/session/snapshot-writer.ts` |
| `session/budget-state.json` | `src/services/context-budget-service.ts` |
| `curator-summary.json` | `src/hooks/curator.ts` |
| `curator-briefing.md` | `src/hooks/phase-monitor.ts` |
| `knowledge-events.jsonl` | `src/hooks/knowledge-events.ts` (FIFO trims and the baseline write, all via `atomicWriteFile`) |
| `evidence/<taskId>/evidence.json` | `src/evidence/manager.ts` (`saveEvidence`'s read-modify-write, and the flat-retrospective migration write-back inside `loadEvidence`) |
| `drift-report-phase-<N>.json` | `src/hooks/curator-drift.ts` (`writeDriftReport`) |
| `summaries/<id>.json` | `src/summaries/manager.ts` (`storeSummary`'s temp-file + `renameSync`) |
| `evidence/req-coverage-phase-<N>.json` | `src/tools/req-coverage.ts` (the report write) |

`run-memory.jsonl` is in the cached set but has no non-append writer, so it
needs no invalidation.

The `spec-staleness.json` row is the one this change's own guard originally
missed, and it is the most consequential entry in the table: `loadPlan` writes
the marker and `src/hooks/system-enhancer.ts:152` reads it back through
`readCachedParsedFileSync` **in the same turn**. A later-turn rewrite whose only
changed field is the fixed-width ISO `timestamp` is byte-identical in length, so
inside one timestamp tick the previous turn's snapshot would be served to the
spec-drift advisory that gates `save_plan` / `update_task_status` /
`phase_complete`.

Appends to `events.jsonl` are deliberately untouched: an append to a surviving
file strictly increases its size, so the stamp differs and the cache misses.
Every write to `.swarm/events.jsonl` in `src/` is an append; the file is deleted
(never truncate-rewritten) by `/swarm close` and `/swarm reset`, and while it is
absent the null stamp bypasses the cache entirely. The residual: once an append
RECREATES a deleted file the stamp is non-null again and could alias the
pre-deletion entry at the same size. That needs the read, the delete and the
recreate inside one filesystem timestamp tick, and both deletions are
user-initiated commands, so it is not a reachable sequence here. The one FIFO-rewritten
events log, `src/hooks/hive-transaction.ts`, targets
`shared-knowledge-events.jsonl` in the cross-project hive directory — not
`.swarm/events.jsonl` — and routes through `atomicWriteFile` regardless.

The regression guard is split across two files. The whole-tree scan lives in
`tests/unit/build/swarm-write-cache-invalidation-scan.test.ts`; the
falsifiability fixtures — unsafe fixture → exactly one violation, safe fixture →
zero, for each of the three write shapes (`renameSync`/`rename`/`fs.rename`/
`fs.promises.rename` targets, direct `bunWrite`/`writeFileSync`/`writeFile`
calls, and the `transactFile` write callback) — live in
`tests/unit/build/swarm-write-cache-invalidation-shapes.test.ts`. Three
mechanisms decide what the scan can see, and all three matter:

- the cached-filename harvester reads the second argument of
  `readSwarmFileAsync(...)` **and** the first argument of
  `readCachedTextFile(Sync)` / `readCachedParsedFile(Sync)`. The second half was
  added in review round 4; without it the harvester was blind to every direct
  consumer of the cache, which is exactly how the `spec-staleness.json` writer
  above stayed invisible to all three rules;
- both the harvester and the rename/write target resolution follow a target
  reached through a chain of local variables, not just a single
  `path.join(...)` / `validateSwarmPath(...)` declaration — which is what let
  the scan see the `evidence.json` writer;
- artifact names are harvested as **patterns**, not exact basenames. A `${…}`
  interpolation folds to `*`, and an interpolated *constant* folds to its value
  first, so `` `${DRIFT_REPORT_PREFIX}${report.phase}.json` `` becomes
  `drift-report-phase-*.json`. The previous version deleted `${…}` outright,
  reducing that same expression to the degenerate remainder `.json`, which is
  why `.swarm/drift-report-phase-<N>.json` never entered the cached set and no
  rule could match its writer. Matching is one-directional — the cached name is
  the matcher and the write path the subject — so a cached literal like
  `plan.json` still cannot swallow an unrelated `` `${x}.json` `` write.

### What the scan cannot see, enumerated

`UNRESOLVED_READER_REGISTRY` in `tests/helpers/swarm-write-cache-scan.ts` lists
every cached-reader call site whose path argument is not statically resolvable.
The scan test asserts set equality in both directions, so a new unresolvable
reader fails CI until it is registered:

| Site | Category | Declared patterns |
| --- | --- | --- |
| `src/hooks/curator-drift.ts` (`readSwarmFileAsync(directory, filename)`, a `for…of` binding over a `readdir` listing) | declared-patterns | `${DRIFT_REPORT_PREFIX}*.json` |
| `src/hooks/knowledge-curator.ts` (`relativeEvidencePath`, built by `.replace()` from a trigger path) | declared-patterns | `evidence/**` — the reader's real blast radius (see below) |
| `src/hooks/utils.ts` ×2 (the memoization hop and the cache read inside `readSwarmFileAsync` itself) | wrapper-internal | none — names flow in from the wrapper's own call sites |
| `src/hooks/knowledge-store.ts` (`path.resolve()` over a parameter) | no-additional-artifact | none — knowledge `*.jsonl`, written only via `transactKnowledge` → `atomicWriteFile` |
| `src/services/context-budget-service.ts` (`readFileOrEmpty`'s parameter) | no-additional-artifact | none — knowledge-store paths, written only via `atomicWriteFile` |

A declared pattern is itself cross-checked: one that interpolates a constant
must still resolve in its own file (and every literal fragment must still appear
there), one written as a fixed string must still be harvested from some
resolvable reader in `src/`, and a directory-class `**` pattern must have every
literal segment before the `**` still present in the file that walks it. Either
way, a hand-written pattern cannot quietly stop describing anything real.

### `.swarm/evidence/` is governed as a class, not as a list of layouts

An earlier revision of this note claimed the knowledge-curator entry declared
"both evidence layouts in this repo" and therefore "adds no coverage of its
own". **That was false.** The reader's trigger filter is `isEvidencePath` —
`/(?:^|\/)\.swarm\/+evidence\//i` — which is unrestricted at any depth below
`.swarm/evidence/`, while `evidence/*.json` matches only single-level names. At
least four TWO-level layouts existed at the time —
`evidence/<phase>/phase-council.json`, `evidence/<phase>/drift-verifier.json`,
`evidence/<phase>/lean-turbo/*.json` and `evidence/<taskId>/reviewer.json` —
none of which `evidence/*.json` can match, plus a one-level
`evidence/agent-tools-<sid>.json` whose writer was invisible for a different
reason (an inline target expression).

The entry now declares `evidence/**`, matched by a prefix-anchored recursive
branch in `cachedNameMatchesPath`, so the whole directory is one closed class on
the PATH-PATTERN axis: whatever layout a writer invents below `.swarm/evidence/`,
the pattern matches it. Because a directory class deliberately over-approximates,
two counterweights ship with it — a write to a TEMP path (one whose resolved path
is the rename destination's path plus a suffix) that is renamed onto the artifact
inside the same window is excluded, since nothing remains at that path; and every
write site the pattern engine cannot fold is enumerated in
`EVIDENCE_WRITE_BLIND_SPOTS` with a status, asserted for set equality by
`tests/unit/build/swarm-write-cache-evidence-class.test.ts`.

**An earlier revision of this note said "any write below `.swarm/evidence/` must
invalidate, whatever layout it invents" and "a new unfoldable writer under
`.swarm/evidence/` fails CI instead of disappearing". Both were absolutes and
both were false**, for the same reason: a matching path pattern only matters if
some rule SEES the write. Review round 7 injected six unguarded
`.swarm/evidence/` writers into a probe file under `src/` and ran the gates —
`copyFileSync(src, evidencePath)`, `cpSync(src, planPath, {force:true})`,
`open(evidencePath,'w')` + `handle.write(...)`,
`createWriteStream(evidencePath)` + `.write()`, `await Bun.write(evidencePath,
data)`, and `writeFileSync(paths[i], data)`. **All six left every gate green**,
while a class-method `writeFileSync` control went red.

The root cause was structural rather than five missing patterns:
`collectWriteSitesFromSource` — the ENUMERATION that feeds
`EVIDENCE_WRITE_BLIND_SPOTS` — reused the two RULE recognizers as its own. So a
target that was merely *unresolvable* failed the gate, but a head that was
*unrecognised* disappeared from resolution and from enumeration at the same time.
That double blindness is exactly what the round-6 redesign existed to eliminate.

Round 7 replaces both recognizers with one `WRITE_HEADS` table consumed by the
rules, the enumeration, the whole-file early-out, the RULE H helper detector and
the blind-spot cross-check alike. The rules gained RULE C (the copy class:
`copyFile(Sync)`, `cp(Sync)`, `link(Sync)`, `symlink(Sync)` — destination is
argument 2) and RULE S (handle writes: `createWriteStream`, and `open`/`openSync`
gated on a truncating flag, so read-only opens and appends do not fire); RULE W
gained `Bun.write` (anchored on the receiver, so `handle.write(chunk)` payloads
are not read as paths) and `truncate`/`truncateSync`. `looksLikePathExpression`
now accepts element access, so `writeFile(paths[i], …)` is enumerated as a blind
spot instead of dropped.

The claim this note now makes is the one the code enforces. A write call site
reaches a loud outcome — governed by a rule, or registered in
`EVIDENCE_WRITE_BLIND_SPOTS` — if and only if its call head is in `WRITE_HEADS`,
its file is selected by `mentionsEvidencePath`, and its target is path-shaped.
The first of those is machine-checked for CLOSURE against the file-mutating
`node:fs` surface `src/` actually calls: every such API is either a governed head
or a reasoned entry in `EXCLUDED_WRITE_HEADS`
(`tests/unit/build/swarm-write-cache-write-heads.test.ts`). Still outside that
bound, and now listed in KNOWN LIMITATIONS rather than implied away: a shelled-out
mutation (`execSync('cp …')`), `Bun.file(p).writer()` and other method-on-a-value
stream heads, a cross-module write helper (resolution is single-file), and a
class- or object-literal-method write helper, which RULE H cannot govern but the
enumeration does record.

Two LIVE unguarded writers fell out of the widened head table and are fixed here:

- `src/tools/update-task-status.ts` created `.swarm/evidence/<taskId>.json` with
  `fs.openSync(evidencePath, 'wx')` + `writeSync` and never invalidated. The path
  is a cached artifact (`evidence/*.json`), and while `wx` only ever creates, the
  same path can be read, unlinked (the write-failure branch, `/swarm reset`, a
  rollback) and re-created with byte-identical content inside one timestamp tick.
- `src/tools/sast-baseline.ts`'s `acquireLock` opened
  `.swarm/evidence/<phase>/sast-baseline.json.lock` with `'wx'`. It was invisible
  for a second reason too: `collectFunctions` dropped every function whose RETURN
  TYPE contains an arrow (`Promise<() => void>`), so RULE H never saw the helper.
  That parser gap is fixed as well.

`mentionsEvidencePath` was widened in the same pass. It required a QUOTED literal
containing `evidence`, so a module importing an evidence-path constant or helper
from another module was dropped from the enumeration entirely — and, resolution
being single-file, folded to null anyway. It now also matches identifiers. Cost
measured before the change: 124 → 237 candidate files, +8 registered blind spots.

### `/swarm rollback` now clears the cache, and its restore path is no longer dead

`handleRollbackCommand` restores a legacy `checkpoints/phase-<N>/` checkpoint by
iterating `readdirSync` and `cpSync(src, dest, { recursive: true, force: true })`
into `.swarm/`, excluding only the ledger files. Everything else — `plan.json`,
`plan.md`, `context.md`, `session/state.json`, `summaries/`, `evidence/`
(recursively), `curator-summary.json`, `spec-staleness.json` — was copied over a
cached artifact with nothing clearing the cache, so any restored file of the same
size landing inside one timestamp tick kept serving the pre-rollback value to
every later hook read in the session.

It now calls `resetSwarmArtifactCache()` immediately after the copy loop.
Wholesale rather than per-file is deliberate: the restored set is whatever the
checkpoint directory happens to contain, `cpSync` recurses, and enumerating that
tree would have to track every future artifact layout. The call sits *before* the
partial-failure early return, because a rollback that copied some files and
failed on others has still mutated `.swarm/`. This also gives
`resetSwarmArtifactCache` its first production caller — it was an export with no
non-test consumer.

The static scan does not and cannot guard this (`rollback.ts` constructs no
evidence path, and the copy destination folds to a pattern matching no cached
name), so `tests/unit/commands/rollback-cache-reset-wiring.test.ts` drives the
real command end to end under a frozen stat stamp, with a falsifiability case
that proves the collision is genuinely forced.

Fixing it surfaced a second, larger defect: `const swarmDir =
validateSwarmPath(directory, '')`. That helper requires a NON-EMPTY filename —
both platform branches test `resolved.startsWith(baseDir + path.sep)`, which is
false when `filename` is `''` and `resolved` therefore equals `baseDir` — so the
call threw `Invalid filename: path escapes .swarm directory` on **every**
platform, before a single file was copied. The whole legacy phase-restore path
was dead in production. It read as covered because
`tests/unit/commands/rollback.test.ts` and `rollback-ledger-lock.test.ts` both
`mock.module` `validateSwarmPath` down to a plain `path.join` (the former's own
comment calls it "the empty-filename bug"), so the restore path had only ever run
against a stub. `swarmDir` is now derived as
`path.dirname(validateSwarmPath(directory, '.keep'))`, which keeps every
check the helper performs on `.swarm` itself — symlink rejection and realpath
containment — and the new wiring test exercises the unmocked helper.

### Write-target shapes the rules previously skipped by construction

| Shape | Live instance | Status |
| --- | --- | --- |
| inline path expression at the call site — `writeFile(path.join(dir, name), data)` | `src/agents/index.ts` (agent-tools snapshot) | resolved; the live instance is also hoisted into a local so every other check can see it |
| call to a same-file single-`return` path helper | `phaseEvidencePath()` in `src/tools/submit-phase-council-verdicts.ts`, `leanTurboEvidenceDir()` in `src/turbo/lean/evidence.ts` | resolved, transitively |
| `swarmPath(directory, …)` pass-through | `src/evaluation/store.ts`, `src/consensus/store.ts` | resolved (added to the path-producer set). Forward-looking only: no rule depends on it today, because both live sites route through `atomicWriteFile`. Covered by a fixture plus an assertion that both definitions really are `path.join(directory, '.swarm', ...segments)` |
| declaration without an initializer — `let p: string;` then `p = validateSwarmPath(…)` | `src/tools/write-drift-evidence.ts` | resolved |
| target arriving as a same-file helper's PARAMETER | `atomicWriteJson()` in `src/turbo/lean/evidence.ts`, `writeRawSidecar()` in `src/summaries/store.ts`, `truncateTrajectoryFile()` in `src/hooks/trajectory-logger.ts` | new RULE H — the invalidation is required in the helper's body, keyed on that parameter |
| target built by an operation the engine does not model (`path.relative`), or by a runtime argument | `src/review/evidence.ts`, `src/tools/sbom-generate.ts` | still unfoldable — registered in `EVIDENCE_WRITE_BLIND_SPOTS`, and both now invalidate explicitly |

### Fail-opens closed in the guard itself

An independent review of the round-6 changes found three ways the *guard* could
be satisfied without the artifact actually being fresh. All three are fixed and
each has a fixture plus a mutation check:

- **The comment blanker desynced on regex literals.** Every check runs on
  comment-blanked source; a regex containing an odd number of backticks
  (`src/tools/completion-verify.ts`) flipped template-literal parity and left
  every comment after it unblanked, so a *commented-out*
  `invalidateCachedArtifact(...)` satisfied the guard. The lexer now models
  regex literals, and an invariant test asserts the blanker ends in code state
  for every file in `src/` — turning any future lexer gap from silent to loud.
- **The temp-file exclusion used proximity, not derivation.** A write followed
  by *any* rename of the same variable in the window was excused, so
  `writeFile(evidencePath, …); if (x) rename(evidencePath, archive)` and a
  catch-branch rename both slipped through. The written path must now resolve to
  the rename destination's path *plus a suffix* — the real
  `` tempPath = `${evidencePath}.tmp` `` shape — and a second write to the same
  target before the rename cancels the exclusion.
- **The blind-spot cross-check was a raw substring search.** It is the only
  protection for the two writers no static rule can see, and commenting out
  either call left it green. It now blanks comments and requires the call to
  follow the write.

Three smaller tightenings: RULE H requires the invalidation to sit *after* the
write in the helper body and now also parses arrow-function helpers; the
nearby-invalidation check compares the whole argument instead of a substring, so
`invalidateCachedArtifact(pOther)` no longer satisfies a write to `p`.

### RULE P now pins the argument, not just the call

`tests/helpers/trusted-root-validator-scan.ts` required only that a guarded
entry point contain *some* `validateProjectDirectory(` call. A body validating
an unrelated local would have satisfied it while the trusted root went
unchecked. Each `GUARDED_ENTRY_POINTS` row now names the parameter carrying the
root, and the rule requires `validateProjectDirectory(<that parameter>)` and
verifies the named parameter really is declared on that function.

## Why

Two shipped compatibility fixes were silently inert, and the repository's own
invariant documentation asserted behaviour that no code path produced. Any
future hook author reading those docs would have reproduced the same defect.

## Migration

No configuration changes. One **real behavioural change** to be aware of:

System messages that hooks splice into the middle or the end of the chat
history — knowledge injection, memory recall, guardrail advisories, delegation
guidance, issue-trace `[MODE: …]` directives — are now **merged into a single
system message at index 0**, and any leftover system message at index > 0 is
stripped.

Text content survives; its **position changes**: content that previously sat
immediately before the last user message (or at the tail) now appears at the
head of the transformed message array. Models that were tuned against the old,
positionally-scattered layout may weight those blocks differently.

"Text content survives" is not "nothing is lost" — an earlier draft of this note
claimed the latter, and it is false. Three shapes lose content. Each was
reproduced by executing `consolidateSystemMessages` on a synthetic input:

- a system message classified as a misclassified tool result (one carrying
  `tool_call_id` / `name`) is **removed, not merged**
  (`src/hooks/messages-transform.ts:165`). This is deliberate — such a message
  is a tool result wearing the wrong role — but it does mean an advisory
  injected with a `name` field disappears entirely;
- a system message whose `content` is neither a string nor a text-part array is
  counted as merged but contributes no text
  (`src/hooks/messages-transform.ts:167-172`), so its content is discarded
  silently;
- the consolidated message's `parts` array is replaced by a single merged text
  part (`src/hooks/messages-transform.ts:113-118`), so any non-text part
  (`file`, `image`) on the first system message is dropped.

`consolidateSystemMessagesInPlace` runs on a second host surface: session
compaction. The host's `SessionCompaction.process` (binary offset
~100,620,534) does `ze = structuredClone(P.head); yield*
i.trigger("experimental.chat.messages.transform",{},{messages:ze})` and then
reads `ze` back — `let to = ze.map(Ld).filter(Boolean).join("\n\n")` — so the
same `experimental.chat.messages.transform` chain, and therefore the same
in-place consolidation, applies there too. The host's `Ld` renderer (binary
offset ~100,615,010) formats every non-`user`-role message — including the
consolidated `system` message — as `[Assistant]: <text>`. The joined result
(`to`) is then **the entire transcript the summarizer sees**, not a prefix ahead
of one: the host calls the summarizer with `system: []` and a single synthesized
user message whose text is
`[<prompt>, "The following is the conversation history:", to].join("\n\n")`
(binary offset ~100,621,010). Practically: consolidated system content now also
shows up, relabelled `[Assistant]:`, at the start of whatever transcript the
compaction summarizer model sees, in addition to its effect on the live chat
request.

## Caveats

- The consolidation guarantees at most one system-role message *within the
  transformed message array*. The host prepends its own system entries
  separately, so "exactly one system message at index 0" is not achieved
  end-to-end and never was.
- **The host's "collapse to at most two system messages" reshape is
  conditional, and the role filter now mutates the array it inspects.** The
  host builds its own list `l`, remembers `i = l[0]`, runs the
  `system.transform` chain, and only reshapes when `l.length > 2 && l[0] === i`
  (binary ~100,587,200). `src/context/role-filter.ts` now clears and refills `l`
  in place — correct, and the whole point of this change — but if the filter
  ever drops or reorders the first entry, `l[0] !== i`, the host skips the
  reshape, and more than two system messages reach the model: the exact `#628`
  crash class this repo already shipped a fix for. Today the base prompt is
  untagged, so `parseForTag` returns `null` and it is retained first. Nothing in
  production *enforces* that, so
  `tests/unit/context/role-filter-wiring.test.ts` now pins it: the first entry
  must be the same value after filtering as before.
- The source-scan guard's `REBIND_RE`
  (`tests/unit/hooks/chat-transform-rebind-guard.test.ts`) matches
  `.system`/`.messages` **assignment** syntax after comment stripping, including
  quoted computed access (`output['messages'] = x`, added in review round 4
  after the dot-only pattern was found to miss it). Any rebind that does not
  produce a `.system`/`.messages` assignment or a quoted-computed one is still
  invisible to it. Confirmed evading shapes — probed against the current
  pattern, and this list is **not** claimed to be exhaustive:
  `Object.assign(output, { messages: … })` (a call, not an assignment);
  the destructured-swap `({ messages: output.messages } = { … })` (an
  assignment, but the `}` between the property access and `=` breaks the
  pattern's `\s*=` requirement); backtick computed access
  ``output[`messages`] = x`` (the pattern's bracket branch accepts `'` and `"`
  only); variable-key access `const k = 'messages'; output[k] = x`; and
  `Reflect.set(output, 'messages', x)`.
  The backstop is
  `tests/unit/hooks/chat-transform-composed-chain-in-place.test.ts`, which
  asserts `expect(output.messages).toBe(original)` after driving the whole
  registered chain. Because `composeHandlers` hands the *same* `output` object
  to every handler, that assertion fails for a rebind in **any**
  `messages.transform` handler that executes under that fixture, not only the
  final one — `Object.assign` and every other evasion shape included. It does
  **not** cover the `system.transform` chain, nor any `messages.transform`
  handler the fixture does not exercise: a rebind there is caught by the source
  scan's assignment matching alone.
  `tests/unit/hooks/system-message-consolidation-in-place.test.ts` is *not* a
  backstop for evasion shapes in production — it calls
  `consolidateSystemMessagesInPlace` directly and never loads `src/index.ts`.
