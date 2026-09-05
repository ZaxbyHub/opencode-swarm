/**
 * Scanner machinery for the G2 guardrail (issue #1729 follow-up): the swarm-artifact-cache validates
 * freshness by stat stamp alone (mtimeMs + ctimeMs + size). A writer that
 * overwrites a `.swarm/` artifact path that a reader actually consumes through
 * the cache (readSwarmFileAsync / readCachedTextFile(Sync) /
 * readCachedParsedFile(Sync)) MUST either route through the shared
 * `atomicWriteFile` helper (src/evidence/task-file.ts, which unconditionally
 * invalidates after a successful rename) or call
 * `invalidateCachedArtifact(targetPath)` itself after the write — otherwise a
 * same-size rewrite inside one filesystem timestamp tick can silently serve
 * stale content to the next reader (see the docblock on
 * `invalidateCachedArtifact` in src/utils/swarm-artifact-cache.ts).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCAN IS STRUCTURED THE WAY IT IS (2026-08-11, #1619 rounds 5-7)
 * ---------------------------------------------------------------------------
 * FIVE consecutive review rounds each found exactly ONE more unguarded writer
 * after the sweep had been declared complete. That is a broken ENUMERATION
 * mechanism, not bad luck: every miss was an artifact whose name the harvester
 * could not represent, or a writer whose target expression the rules skipped by
 * construction — and either way the scan goes silently blind rather than merely
 * incomplete. Round 6 additionally found that two of the docblock's own SCOPE
 * CLAIMS were false (see the KNOWN LIMITATIONS entry on parameter-passed
 * writers, and THE `evidence/**` CLASS below), which is why the claims here are
 * now machine-checked wherever a claim can be.
 *
 * ROUND 7 found the deepest instance of the same defect, and it did not find it
 * by reading code: it INJECTED six unguarded `.swarm/evidence/` writers into a
 * probe file under src/ and ran the gates. Five stayed green. The cause was that
 * `collectWriteSitesFromSource` — the enumeration that is supposed to catch
 * whatever the rules cannot resolve — reused the RULE recognizers as its own. A
 * shape that was merely UNRESOLVABLE therefore failed the gate, while a shape
 * whose call head was UNRECOGNISED vanished from resolution AND enumeration
 * simultaneously. `WRITE_HEADS` is the fix: one head table, consumed by the
 * rules, the enumeration, the whole-file early-out, the RULE H helper detector
 * and the blind-spot cross-check alike, and machine-checked for CLOSURE against
 * the file-mutating `node:fs` surface `src/` actually calls.
 *
 * The structural changes that make the enumeration authoritative are:
 *
 *   1. PATTERNS, NOT EXACT BASENAMES. Artifact names are harvested as glob-ish
 *      patterns where a `${…}` interpolation (or any expression the scan
 *      cannot fold to a literal) becomes `*`. The round-4 miss was
 *      `.swarm/drift-report-phase-<N>.json`: the old `extractLiteralBasename`
 *      DELETED `${…}` outright, reducing
 *      `` `${DRIFT_REPORT_PREFIX}${report.phase}.json` `` to the degenerate
 *      remainder `.json`, so the artifact never entered the set and no rule
 *      could match its writer. Interpolations of a resolvable string constant
 *      are folded to their value first (`${DRIFT_REPORT_PREFIX}` ->
 *      `drift-report-phase-`), which is what keeps the pattern specific
 *      instead of collapsing to a floody `*.json`.
 *   2. EVERY READER CALL SITE LANDS IN EXACTLY ONE BUCKET — resolved, or
 *      explicitly registered in `UNRESOLVED_READER_REGISTRY`. A reader whose
 *      path argument is not statically resolvable (a function parameter, a
 *      `for…of` loop binding, a string built by `.replace()`) used to be
 *      silently dropped. It now fails the gate until a human registers it with
 *      a stated reason and, where applicable, the artifact patterns it reads —
 *      which are then added to the cached set. `KNOWN LIMITATIONS` below is
 *      therefore machine-checked, not prose that drifts.
 *   3. THE READER LIST IS DERIVED FROM THE CACHE MODULE'S OWN EXPORTS. The
 *      round-3 miss (`spec-staleness.json`) happened because the harvester
 *      knew about `readSwarmFileAsync` but not the direct `readCached*`
 *      consumers. `collectExportedCacheReaders()` reads the exported `read*`
 *      functions out of src/utils/swarm-artifact-cache.ts, and the assertions
 *      require `CACHED_READER_SIGNATURES` to cover them, so adding a fifth
 *      cached reader to the cache module fails the gate instead of shrinking
 *      this scan's blast radius to zero.
 *
 * Scope discriminator: the cache is keyed by resolved artifact path, not by
 * source file, so "does this write matter" is decided by "is this exact
 * artifact ever read through a cached reader anywhere in src/" — NOT by
 * whether `.swarm` merely appears near the write.
 *
 * HARVEST (read side). For every call site of every reader in
 * `CACHED_READER_SIGNATURES`, the path argument (argument two for
 * `readSwarmFileAsync`, argument one for the direct `readCached*` consumers)
 * is folded to a pattern by `resolvePattern`, which understands:
 *   - string literals (`'plan.md'`, `'session/state.json'`);
 *   - template literals, with `${IDENT}` folded through the same
 *     variable/constant table and every other interpolation becoming `*`;
 *   - path-producer calls (`path.join` / `path.resolve` / `validateSwarmPath`
 *     / bare `join` / `resolve`), whose arguments are folded recursively and
 *     kept as separate path UNITS so a multi-segment literal argument
 *     (`'session/state.json'`) is never split apart;
 *   - bare identifiers, resolved against the nearest preceding
 *     `const`/`let`/`var` declaration in the same file — transitively, because
 *     the table is built in source order and each hop consults the entries
 *     already resolved. Plain string constants resolve too
 *     (`const RUN_MEMORY_FILENAME = 'run-memory.jsonl'`), which the previous
 *     version could not do.
 * The trailing unit becomes the harvested name; if it is not SPECIFIC (its
 * basename stem carries no literal run of 2+ characters, e.g. `*.json`),
 * preceding units are prepended until it is (`summaries/*.json`,
 * `evidence/*.json`). A name that can never be made specific is treated as
 * unresolved rather than admitted — a degenerate name such as `.json` or `*`
 * would match nearly every JSON write in src/ and flood the report.
 *
 * RULES (write side). Local variables are resolved to the artifact they point
 * at by the same pattern engine, plus the original literal matcher (a cached
 * name appearing verbatim as a quoted argument, or bare inside a template) so
 * no previously-covered shape can regress. Then:
 *
 *      RULE R (rename):  `renameSync(<anything>, <cachedVar>)`, bare
 *                        `rename(<anything>, <cachedVar>)` (destructured
 *                        `import { rename } from 'node:fs/promises'`), and any
 *                        member-access chain ending in `.rename(`
 *                        (`fs.rename(`, `fs.promises.rename(`,
 *                        `_test_exports.rename(`).
 *      RULE W (direct):  `bunWrite(<cachedVar>` / `writeFileSync(<cachedVar>` /
 *                        `writeFile(<cachedVar>` / `Bun.write(<cachedVar>` /
 *                        `truncate(Sync)(<cachedVar>` — including member forms
 *                        such as `fs.writeFileSync(` and
 *                        `_internals.writeFileSync(`.
 *      RULE C (copy):    `copyFile(Sync)(<anything>, <cachedVar>)`,
 *                        `cp(Sync)(<anything>, <cachedVar>, opts)`,
 *                        `link(Sync)` / `symlink(Sync)`. A copy overwrites its
 *                        DESTINATION exactly as a write does. Added in round 7,
 *                        and deliberately NOT folded into RULE R: a rename
 *                        EMPTIES its source, a copy does not, and sharing the
 *                        recognizer would turn the temp-file exclusion into a
 *                        fail-open.
 *      RULE S (handle):  `createWriteStream(<cachedVar>)` and
 *                        `open(Sync)(<cachedVar>, <write flag>)`. The bytes are
 *                        written later through a handle or fd that no longer
 *                        names the path, so the OPENING call is the only place a
 *                        rule can key on. Gated on the flag: read-only (`r`) and
 *                        the append family (`a`, `a+`, …) do not fire — an
 *                        append always grows the file, so the stamp always
 *                        differs — while `w`, `wx`, `r+` and any NON-LITERAL
 *                        flag do. Added in round 7.
 *      RULE T (transact): `transactFile(<cachedVar>, read, write, mutate)` —
 *                        the repo's read-modify-write primitive hands the path
 *                        to its `write` callback, so the invalidation lives in
 *                        that callback's body, not at the call site. The rule
 *                        resolves the callback identifier to a function in the
 *                        same file and requires `invalidateCachedArtifact(` in
 *                        its body.
 *      RULE H (helper):  a call to a SAME-FILE function that writes to one of
 *                        its own parameters (`atomicWriteJson(filePath, data)`,
 *                        `writeRawSidecar(absPath, bundle)`,
 *                        `truncateTrajectoryFile(filePath, max)`). Same shape as
 *                        RULE T: the invalidation must live in the helper's
 *                        body, keyed on that parameter, and positioned AFTER the
 *                        write — an invalidation before the write does not make
 *                        the artifact fresh. Added in round 6; it is what makes
 *                        the previously-documented dead end "a writer that
 *                        receives its target as a PARAMETER is invisible" false
 *                        for same-file helpers.
 *
 *      R, W, C and S all require a nearby `invalidateCachedArtifact(<sameVar>)`
 *      call. They are ONE loop over ONE table (`WRITE_HEADS`) that the
 *      enumeration also consumes — see that table's docblock for why sharing it
 *      is the whole point of round 7.
 *
 * TARGET SHAPES the rules resolve (round 6 added four; round 7 added the last):
 *   - a bare identifier declared from a path producer or template literal;
 *   - an INLINE path expression at the call site — `writeFile(path.join(dir,
 *     name), data)`. Before round 6 every rule began
 *     `if (!/^[A-Za-z0-9_$]+$/.test(target)) continue;`, so an inline target was
 *     skipped BY CONSTRUCTION while the docblock asserted no such shape could
 *     exist. An inline target has no variable to key an invalidation on, so it
 *     is reported unless the identical expression is passed to
 *     `invalidateCachedArtifact` in the forward window; hoisting the path into a
 *     local is the intended fix (the snapshot write in src/agents/index.ts getAgentConfigs is the live example);
 *   - a call to a SAME-FILE single-`return` path helper
 *     (`phaseEvidencePath(...)`, `leanTurboEvidenceDir(...)`), resolved by
 *     folding the helper's own return expression with its parameters treated as
 *     `*`. Chains resolve transitively with a recursion guard;
 *   - `swarmPath(directory, …)` — a same-file `path.join(directory, '.swarm',
 *     ...segments)` pass-through in src/evaluation/store.ts and
 *     src/consensus/store.ts. It is in `PATH_PRODUCER_RE` rather than resolved
 *     as a single-return helper because its rest parameter would otherwise
 *     swallow the caller's literal segments;
 *   - a bare `name = <rhs>` ASSIGNMENT, not only a declaration with an
 *     initializer. `let validatedPath: string;` followed by
 *     `validatedPath = validateSwarmPath(...)`
 *     (src/tools/write-drift-evidence.ts) was unresolvable before round 6.
 *   - an ELEMENT-ACCESS target (`writeFile(paths[i], data)`), round 7. The
 *     engine still cannot FOLD it, so it is never governed by a rule — but
 *     `looksLikePathExpression` now accepts it, so it is ENUMERATED and must be
 *     registered in `EVIDENCE_WRITE_BLIND_SPOTS`. Before round 7 the dot-only
 *     pattern rejected it and the site vanished from both axes at once, which is
 *     the same failure mode as an unrecognised call head.
 *
 * DELIBERATE EXCLUSIONS (each is provably safe, not an oversight):
 *
 *   - Appends (`appendFile`, `appendFileSync` — ~15 sites on events.jsonl), and
 *     since round 7 the append FLAGS of the RULE S heads too (`open(p, 'a')`,
 *     `createWriteStream(p, { flags: 'a' })`).
 *     An append to a SURVIVING file strictly increases its size, so the stat
 *     stamp differs and the cache misses. That is the bound: a delete followed
 *     by a recreating append (`rmSync(p); appendFile(p, …)`) can land the same
 *     size and alias, and no head in `WRITE_HEADS` sees it. Round 8 injected
 *     that shape and it stayed green. It is excluded anyway because every live
 *     append site in `src/` is a pure append with no unlink in the same
 *     operation, and because the aliasing additionally requires the read, the
 *     delete and the recreate to fall inside one filesystem timestamp tick.
 *     The one place events.jsonl is
 *     truncate-rewritten instead of appended (src/hooks/hive-transaction.ts,
 *     trimming) goes through `atomicWriteFile`.
 *   - Writes through an already-open DESCRIPTOR or FileHandle (`write`,
 *     `writeSync`, `writev`, `ftruncate`). The path is named at the
 *     `open`/`createWriteStream` that produced the handle, and RULE S governs
 *     that call. Making `write` a head would additionally read every
 *     `stream.write(chunk)` payload as a path.
 *   - Directory and metadata operations (`mkdir`, `mkdtemp`, `opendir`, `rmdir`,
 *     `utimes`, `chmod`, `chown` and their variants). None changes file content;
 *     the timestamp/permission ones only ever make the stamp DIFFER, which makes
 *     the cache miss — the safe direction.
 *     Each exclusion above is an entry in `EXCLUDED_WRITE_HEADS` with its
 *     argument, and the closure test asserts no excluded name is also a governed
 *     head.
 *   - `atomicWriteFile(...)` callers. The helper invalidates internally; that
 *     is the contract other writers route through. It is not in the RULE W
 *     alternation, and its own body is exempted via CANONICAL_HELPER.
 *   - Renames whose cached artifact is the SOURCE, not the target
 *     (`renameSync(handoffPath, consumedPath)` in system-enhancer.ts,
 *     `renameSync(resolvedPath, quarantinePath)` in snapshot-reader.ts).
 *     These REMOVE the artifact; the next `getStamp` returns null and the
 *     cached reader bypasses the cache entirely. RULE R checks argument 2
 *     only, which excludes them without needing an allowlist.
 *   - Plain deletions (`unlink` / `unlinkSync` / `rm`). Same argument as the
 *     rename-source case, and it is load-bearing for `spec-staleness.json`:
 *     `src/commands/acknowledge-spec-drift.ts` only reads and `unlink`s it,
 *     never rewrites it. Once the file is gone `getStampSync` returns null,
 *     `readCachedParsedFileSync` skips the cache and calls `readText()`, which
 *     yields null — so a leftover cache entry for a deleted path is
 *     unreachable and needs no invalidation.
 *   - A RULE W write whose target is the SOURCE of a rename inside the forward
 *     window (`writeFile(tempPath, …); rename(tempPath, evidencePath)`) AND
 *     whose match came from a directory-class `**` pattern. Same reasoning as
 *     the rename-source exclusion above: nothing remains at the written path.
 *     Round 6 added this because the `evidence/**` pattern matches temp files
 *     under `.swarm/evidence/` too, and without it the guard would demand a
 *     pointless `invalidateCachedArtifact(tempPath)` at six sites. It is
 *     deliberately NOT applied when the artifact matched a specific cached
 *     name: there the rename could be conditional and the artifact could
 *     survive at the written path, so the report is the right outcome. It is
 *     also not applied when a SECOND write to the same target sits between this
 *     write and the rename, because then the rename belongs to that later write.
 *     Residual limitation: the pairing is textual over a 25-line window, not a
 *     data-flow link, so a rename that is CONDITIONAL (`if (x) rename(temp,
 *     dest)`) still excuses the write. No `.swarm/evidence/` writer has that
 *     shape today; all six are unconditional temp-then-rename pairs on adjacent
 *     lines.
 *
 * THE `evidence/**` CLASS (round 6). `.swarm/evidence/` is governed as a whole
 * DIRECTORY, not as a list of layouts. The knowledge-curator reader's trigger
 * filter `isEvidencePath` (src/hooks/knowledge-curator.ts) is
 * `/(?:^|\/)\.swarm\/+evidence\//i` — unrestricted at any depth — so the
 * registry declares `evidence/**` and `cachedNameMatchesPath` grows a
 * prefix-anchored recursive branch for it. Rounds 1-5 declared
 * `evidence/*.json` + `evidence.json` and asserted those were the only two
 * layouts in the repo. At that moment there were at least four TWO-level
 * layouts that `evidence/*.json` cannot match — `evidence/<phase>/phase-council.json`,
 * `evidence/<phase>/drift-verifier.json`,
 * `evidence/<phase>/lean-turbo/lean-turbo-phase.json` and
 * `evidence/<taskId>/reviewer.json` — plus a one-level one,
 * `evidence/agent-tools-<sid>.json`, whose writer was invisible for a different
 * reason (an inline target expression). Because a directory class
 * over-approximates, the write-side blind spots it cannot fold are
 * enumerated in `EVIDENCE_WRITE_BLIND_SPOTS` and asserted for set equality by
 * tests/unit/build/swarm-write-cache-evidence-class.test.ts — the write-side
 * mirror of `UNRESOLVED_READER_REGISTRY`.
 *
 * KNOWN LIMITATIONS (measured, and — since round 5 on the read side, round 6 on
 * the write side — machine-enforced rather than prose):
 *
 *   - A reader whose path argument is not statically resolvable is NOT
 *     silently ignored: it must appear in `UNRESOLVED_READER_REGISTRY`, and
 *     `tests/unit/build/swarm-write-cache-invalidation-scan.test.ts` asserts
 *     set equality in both directions plus
 *     `resolved + registered == total call sites`. The registry has exactly
 *     three categories, and every entry states why nothing is hidden:
 *       * `wrapper-internal` — the site is inside `readSwarmFileAsync` itself,
 *         whose own call sites are what the harvester reads.
 *       * `declared-patterns` — the artifact IS cached and its patterns are
 *         declared by hand; each declared pattern is cross-checked against the
 *         registered file's source so renaming the underlying constant fails
 *         the gate instead of silently killing the rule.
 *       * `no-additional-artifact` — the path is a runtime parameter whose
 *         artifacts are already covered, or are written exclusively through
 *         `atomicWriteFile`.
 *   - A WRITER that receives its target path as a function PARAMETER is not
 *     resolvable at the write statement itself. RULE T closes that for
 *     `transactFile` and RULE H closes it for a SAME-FILE helper declared as
 *     `function name(…)` or `const name = (…) => {…}` that writes to one of its
 *     own parameters, in both cases by moving the requirement into the callee's
 *     body. NOT covered: class methods and object-literal methods, which
 *     `collectFunctions` does not parse, so RULE H cannot move the requirement
 *     into their bodies.
 *     What happens to one is NOT what the pre-round-7 text here claimed. It said
 *     such a writer "would surface in `EVIDENCE_WRITE_BLIND_SPOTS` because its
 *     call-site argument is what the enumeration records" — but the enumeration
 *     records the WRITE site's own target, never a call-site argument. The real
 *     mechanism, verified in round 7 by injecting a class-method
 *     `writeFileSync(evidencePath, data)` into `src/`: because the method is not
 *     in `writeHelpers`, its body is never suppressed as a governed-helper span,
 *     so RULE W/R/C/S fires DIRECTLY on the body whenever the target resolves
 *     there (the injected control was reported as a RULE W violation). When the
 *     target does not resolve, the site lands in `EVIDENCE_WRITE_BLIND_SPOTS` as
 *     an unfoldable write — which is what `src/evidence/documents-retention.ts`'s
 *     `_internals.openSync` object-literal shim does today. Both outcomes are
 *     loud; only the stated mechanism was wrong.
 *     ALSO LEFT OPEN is the case of a write helper defined in a
 *     DIFFERENT module from its caller: resolution is single-file, so neither
 *     rule can pair the caller's argument with the callee's body. No current
 *     `.swarm/evidence/` writer has that shape — the round-6 sweep found
 *     `atomicWriteJson` (src/turbo/lean/evidence.ts), `writeRawSidecar`
 *     (src/summaries/store.ts) and `truncateTrajectoryFile`
 *     (src/hooks/trajectory-logger.ts), all same-file. Two cross-module write
 *     helpers exist and neither escapes: `bunWrite` (src/utils/bun-compat.ts) is
 *     itself a RULE W head, so its call sites are governed directly; and
 *     `atomicWriteFile` (src/evidence/task-file.ts) invalidates internally,
 *     which is the contract every helper that is NOT a head should follow.
 *     NOTE: the pre-round-6 text here claimed "there is no equivalent registry
 *     on the write side: a writer is only reachable through some caller that
 *     names the artifact, and that caller is what the rules see". That was
 *     false in two ways — an inline target was skipped by construction, and a
 *     caller that names the artifact through a helper call or an uninitialised
 *     `let` was not seen either. `EVIDENCE_WRITE_BLIND_SPOTS` is now that
 *     registry, scoped to the `.swarm/evidence/` class.
 *   - Shapes the pattern engine still folds to null, each with a live instance
 *     (all are enumerated by `collectEvidenceBlindSpots`, so none of them can
 *     hide a NEW evidence writer — a new one fails the gate until registered):
 *       * a path built by a string operation the engine does not model, e.g.
 *         `validateSwarmPath(directory, path.relative(...))` in
 *         src/review/evidence.ts:143. `path.relative` is not a path PRODUCER;
 *         modelling it would require knowing both operands.
 *       * a path from a MULTI-statement same-file helper —
 *         `getHistoryPath()` (src/test-impact/history-store.ts:27) validates
 *         its argument before returning, so it is not a single-`return`
 *         producer. Only single-`return` helpers are folded, on purpose: a
 *         multi-statement body can return different paths on different
 *         branches, and picking one would be a guess.
 *       * a path whose directory is a runtime tool ARGUMENT with a default
 *         applied at call time — `outputDir` in src/tools/sbom-generate.ts:306,
 *         whose default is the module constant `.swarm/evidence/sbom` but whose
 *         value is a parameter.
 *       * a path constant imported from ANOTHER module —
 *         `resolveInsightCandidatesPath` (defined in src/hooks/micro-reflector.ts,
 *         imported by src/hooks/knowledge-curator.ts). Resolution is
 *         single-file; the same-file helper folding above does not cross module
 *         boundaries. The artifact it names, insight-candidates.jsonl, is not
 *         cached.
 *   - RULE T itself only resolves a write callback passed as an IDENTIFIER
 *     (`writeCuratorSummaryState`, `_internals.writeCuratorSummaryState`). A
 *     callback written as an inline arrow is skipped. Audited 2026-09-02
 *     (#2480 re-audit): the insight-candidates.jsonl transactFile writers in
 *     knowledge-curator/micro-reflector were REMOVED (the durable queue is
 *     now the swarm.db insight_candidate stream); of the remaining matches,
 *     one is the function definition itself, one (`src/hooks/curator.ts:877`)
 *     passes an identifier and is covered, and the remaining three pass
 *     inline arrows — every one targets a file that is NOT in the cached set,
 *     so nothing is currently hidden:
 *       `src/hooks/knowledge-reader.ts:295`   -> .knowledge-shown.json
 *       `src/hooks/knowledge-store.ts:644`    -> knowledge*.jsonl via
 *          transactKnowledge; its callback also routes through atomicWriteFile
 *       `src/services/recommendation-ledger.ts:623` -> LEDGER_REL_PATH
 *     If one of those ever starts writing a cached artifact, RULE T must be
 *     extended to inline callbacks.
 *   - A write whose basename is ENTIRELY dynamic (`` `session/${name}.json` ``)
 *     is matched only when a cached PATTERN covers it — never by a cached
 *     literal name, because matching is one-directional (the cached name is
 *     the matcher, the write path is the subject). That direction is
 *     deliberate: the reverse would let a write of `` `${x}.json` `` match the
 *     cached literal `plan.json` and flood the report with false positives.
 *   - Variable resolution is name-based, not scope-based: if two functions in
 *     one file declare a same-named variable from unrelated path-producer
 *     calls, the "nearest earlier declaration" heuristic can pick the wrong
 *     binding. Being generous only ever ADDS a candidate flagged for review;
 *     it never hides a real unguarded write.
 *   - Resolution is single-file, INCLUDING the round-6 helper folding: a path
 *     helper or write helper defined in another module is not followed. A
 *     reader that started to depend on one would land in
 *     `UNRESOLVED_READER_REGISTRY`; a writer under `.swarm/evidence/` that did
 *     would land in `EVIDENCE_WRITE_BLIND_SPOTS`. Neither can disappear
 *     silently, which is the property that matters — the resolver being
 *     incomplete is survivable, the enumeration being incomplete is not.
 *   - The comment blanker is a hand-written lexer, and regex-vs-division is
 *     decided by the previous significant token (`REGEX_PRECEDER_RE`). That is
 *     exact for the formatted TypeScript biome produces here, but it is a
 *     heuristic, so `blankedSource().terminalMode` is asserted to be `'code'`
 *     for every file in src/ — a desync is the one lexer failure that would
 *     silently unblank an entire file's comments, which is how round 6's review
 *     satisfied the guard with a commented-out call. That assertion lives in
 *     tests/unit/build/swarm-write-cache-invalidation-scan.test.ts ('the comment
 *     blanker ends in code state for every file in src/'), NOT in
 *     swarm-write-cache-evidence-class.test.ts, which the pre-round-7 text here
 *     and at the `blankedSource` docblock both named.
 *   - Every coverage check is POSITIONAL, not control-flow aware. An
 *     invalidation is required to sit after the write and inside the forward
 *     window (or, for RULE H, after the write inside the helper body) — but an
 *     invalidation that only executes on some paths (inside a `catch`, or a
 *     branch that is not taken) still satisfies it. Making this exact would
 *     require a CFG; the scan deliberately stops at "the call exists, keyed on
 *     the right value, after the write".
 *     COUNT — defined so it cannot drift again; the pre-round-7 figure of "18"
 *     was wrong by more than a factor of two. The metric is textual
 *     `invalidateCachedArtifact(` occurrences under `src/`, excluding
 *     `*.test.ts`, and it counts the definition at
 *     src/utils/swarm-artifact-cache.ts alongside the call sites. The BASELINE is
 *     the branch point, deliberately — not "at HEAD", which goes stale the
 *     moment this lands: `origin/main` has 2 (one call site plus the
 *     definition). Rounds 1-6 added 39; round 7 added 2 more (`acquireLock` in
 *     src/tools/sast-baseline.ts, and the `evidence/<taskId>.json` gate file in
 *     src/tools/update-task-status.ts), for 43 on this branch.
 *     The CONCLUSION is unchanged and was re-audited at this revision: every
 *     call site sits on its writer's unconditional success path — none is
 *     reachable only from a `catch` or a branch that may not be taken.
 *   - The blind-spot enumeration is scoped THREE ways, and "exhaustive" means
 *     exhaustive within that scope, not over all writes:
 *       * only files that `mentionsEvidencePath` selects. Since round 7 that is
 *         a quoted `evidence` path segment, an import specifier containing one,
 *         OR any identifier carrying `evidence` in any casing — the last branch
 *         added because a module importing an evidence-path constant from
 *         ANOTHER module was previously dropped from the enumeration entirely.
 *         Deliberate over-inclusion: it costs registry entries, never coverage.
 *         It is still a heuristic — a constant named without the word (say
 *         `REPORT_DIR = '.swarm/evidence/reports'` imported as `REPORT_DIR`)
 *         escapes it. No such site exists in `src/` today;
 *       * only call sites outside template literals, so example code quoted in
 *         a prompt string is not counted as a writer;
 *       * only call sites outside the body of a helper RULE H already governs,
 *         because those are covered at every call site of that helper instead.
 *     Other cached artifacts rely on the reader-harvested name set plus RULES
 *     R/W/C/S/T/H, exactly as before round 6. Widening the enumeration to every
 *     `.swarm/` artifact is the obvious next ratchet if a miss ever appears
 *     outside `evidence/`.
 *   - WRITE HEADS the scan does not model at all (round 7). `WRITE_HEADS` is
 *     closed against the `node:fs` mutating surface `src/` calls — that is
 *     machine-checked by
 *     tests/unit/build/swarm-write-cache-write-heads.test.ts against
 *     `EXCLUDED_WRITE_HEADS` — but "the node:fs surface" is the bound, and these
 *     are outside it:
 *       * a shelled-out mutation (`execSync('cp …')`, `spawn('mv', …)`) — the
 *         path never appears as a call argument this scan can read;
 *       * `Bun.file(p).writer()` and any other streaming writer whose head is a
 *         method on a value rather than a named call. `Bun.write` is governed
 *         only in its RECEIVER-ANCHORED spelling: `BUN_WRITE_RE` requires the
 *         literal `Bun.`, so a destructured `const { write } = Bun; write(p, d)`
 *         has no head. Anchoring is deliberate — a bare `write` head would read
 *         the payload argument of every `stream.write(chunk)` as a path. No such
 *         destructuring exists in `src/` today (round 8);
 *       * a head reached through COMPUTED member access — `fs['writeFileSync'](p,
 *         data)`. Every head pattern requires `(` immediately after the name, and
 *         the bracket form interposes `']'`. No live instance in `src/` (round 8);
 *       * a CROSS-MODULE write helper (resolution is single-file). Both that
 *         exist route around the gap — `bunWrite` (src/utils/bun-compat.ts) is
 *         itself a RULE W head, so its call sites are governed directly, and
 *         `atomicWriteFile` (src/evidence/task-file.ts) invalidates internally;
 *       * an OBJECT-LITERAL or CLASS method write helper, which
 *         `collectFunctions` does not parse. RULE H therefore cannot govern one,
 *         but its body is NOT hidden: since round 7 the enumeration records it,
 *         so `src/evidence/documents-retention.ts`'s `_internals.openSync` shim
 *         is a registered blind spot rather than an invisible site.
 *
 * The wired-path tests in
 * tests/unit/plan/plan-manager-cache-invalidation-wiring.test.ts and
 * tests/unit/utils/swarm-write-cache-invalidation-wiring.test.ts are the
 * complementary guard for everything the static rules cannot see.
 *
 * Extracted from the test file so that file stays under the FR-006 500-line
 * cap (scripts/check-test-file-cap.ts). The assertions live in
 * tests/unit/build/swarm-write-cache-invalidation-scan.test.ts,
 * tests/unit/build/swarm-write-cache-invalidation-shapes.test.ts,
 * tests/unit/build/swarm-write-cache-evidence-class.test.ts and
 * tests/unit/build/swarm-write-cache-write-heads.test.ts (round 7 — the head
 * table's invariants, one fixture per head family, and the closure statement).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'src');

/**
 * Wall-clock allowance for a test that makes a WHOLE-TREE pass (reading and
 * blanking every file under src/, ~780 files). It lives here rather than in a
 * test file because more than one suite needs it and two copies of a number
 * that must move together is the drift shape this whole guard exists to prevent.
 *
 * It is an allowance, not an assertion: nothing is relaxed by raising it, and a
 * genuine algorithmic regression (round 6's quadratic `lineOf`) overruns this by
 * an order of magnitude rather than by a little. Round 7's head table took the
 * harvest+scan from ~3.4s to ~5.1s locally by recognizing four more head
 * families over ~1.9x as many candidate files.
 */
export const WHOLE_TREE_SCAN_TIMEOUT_MS = 30_000;

// The canonical shared helper — its own renameSync-then-invalidate body is
// exempt because it IS the invalidation contract other writers route
// through.
const CANONICAL_HELPER = join('src', 'evidence', 'task-file.ts');

/** The module that owns the cache and therefore owns the reader list. */
const CACHE_MODULE_REL = 'src/utils/swarm-artifact-cache.ts';

/**
 * The wrapper that most call sites use instead of the raw cache readers. It
 * lives in src/hooks/utils.ts, not in the cache module, so it is the one entry
 * in `CACHED_READER_SIGNATURES` that `collectExportedCacheReaders()` will not
 * report.
 */
export const CACHED_READER_WRAPPER = 'readSwarmFileAsync';

/** `*` in a harvested/derived artifact pattern. */
const WILDCARD = '*';
/**
 * Separator between path UNITS (one per path-producer argument). Keeping units
 * distinct is what stops `validateSwarmPath(dir, 'session/state.json')` from
 * being truncated to `state.json` while still letting
 * `path.join('summaries', `${id}.json`)` be qualified up to `summaries/*.json`.
 */
const UNIT_SEP = '\u0001';
/**
 * Stand-in for `*` inside a WRITE path while it is being matched against a
 * cached name. A literal cached segment must NOT match a fully dynamic write
 * segment, and substituting a character that cannot appear in a filename makes
 * that fall out of ordinary regex matching.
 */
const WRITE_WILDCARD_SENTINEL = '\u0000';

export interface CachedReaderSignature {
	/** Function name as it appears at the call site. */
	readonly name: string;
	/** Zero-based index of the argument that carries the artifact path. */
	readonly pathArgIndex: number;
}

/**
 * Every reader that consults the swarm-artifact cache. `readSwarmFileAsync` is
 * a WRAPPER around `readCachedTextFile`; the other four are the cache module's
 * own exports and are asserted to equal `collectExportedCacheReaders()`.
 */
export const CACHED_READER_SIGNATURES: readonly CachedReaderSignature[] = [
	{ name: CACHED_READER_WRAPPER, pathArgIndex: 1 },
	{ name: 'readCachedTextFile', pathArgIndex: 0 },
	{ name: 'readCachedTextFileSync', pathArgIndex: 0 },
	{ name: 'readCachedParsedFile', pathArgIndex: 0 },
	{ name: 'readCachedParsedFileSync', pathArgIndex: 0 },
];

const READER_BY_NAME = new Map(
	CACHED_READER_SIGNATURES.map((sig) => [sig.name, sig]),
);

/**
 * Matches every cached-reader CALL. Longest names come first so the shorter
 * name cannot win the alternation and leave `Sync(` dangling; a dotted receiver
 * is allowed (`_internals.readCachedTextFile(`) while the lookbehind still
 * rejects an identifier that merely ENDS with one of these names; and explicit
 * generics (`readCachedParsedFile<Plan>(`) are tolerated between the callee and
 * the paren.
 */
const CACHED_READER_CALL_RE = new RegExp(
	`(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]+\\.)*(${CACHED_READER_SIGNATURES.map(
		(sig) => sig.name,
	)
		.sort((a, b) => b.length - a.length)
		.join('|')})\\s*(?:<[^(]*>)?\\s*\\(`,
	'g',
);

/**
 * Path-producing calls this repo uses to build a `.swarm/` artifact path.
 * `validateSwarmPath(dir, 'session/budget-state.json')` is as common as
 * `path.join(dir, '.swarm', 'plan.json')`, and omitting it was why the
 * original scan could not see the budget-state / handoff / snapshot writers.
 */
const PATH_PRODUCER_RE =
	/^(?:await\s+)?(?:[A-Za-z0-9_$]+\.)*(?:validateSwarmPath|swarmPath|join|resolve)\s*\(/;

/**
 * A call to a repo-local helper, e.g. `phaseEvidencePath(dir, phase)`. When the
 * helper is defined in the SAME file as a single `return <path expression>`,
 * `resolvePattern` folds the helper's own return expression instead of giving
 * up. Parameters are unresolvable inside that body and therefore fold to `*`,
 * which is the correct conservative answer: the caller's arguments are dynamic
 * anyway, and `path.join(directory, '.swarm', 'evidence', String(phase),
 * 'phase-council.json')` still yields a SPECIFIC name whose middle segment is a
 * wildcard and whose basename is the literal `phase-council.json`.
 */
const LOCAL_CALL_RE = /^(?:await\s+)?([A-Za-z0-9_$]+)\s*(?:<[^(]*>)?\s*\(/;

/** `function name(` — the head of a candidate single-return path producer. */
const FUNCTION_DECL_RE =
	/(?:^|[\s;}])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^(]*>)?\s*\(/g;

/**
 * `const name = (params) => {` — the arrow-function form of the same thing.
 * Round 6's review showed RULE H claimed to cover "any same-file helper" while
 * `collectFunctions` matched only the `function` keyword, so rewriting a write
 * helper as an arrow silently removed it from the guard.
 */
const ARROW_DECL_RE =
	/(?:^|[\s;}])(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*)?=\s*(?:async\s+)?(?:<[^(]*>)?\s*\(/g;

/**
 * RULE W call heads. The lookbehind rejects `atomicWriteFile(` and any other
 * identifier that merely ENDS with one of these names, while still allowing
 * member forms (`fs.writeFileSync(`, `_internals.writeFileSync(`) because `.`
 * is not an identifier character.
 */
const DIRECT_WRITE_RE =
	/(?<![A-Za-z0-9_$])(?:bunWrite|writeFileSync|writeFile)\s*\(/g;
// Matches `renameSync(`, bare `rename(` (destructured `import { rename } from
// 'node:fs/promises'`), and any member-access chain ending in `.rename(`
// (`fs.rename(`, `fs.promises.rename(`, `_test_exports.rename(`) — the async
// `fs.rename`/`fs.promises.rename` rename is functionally identical to
// `renameSync` for this scan's purposes (same "atomic rename over the cached
// target" shape), and issue #1619 FIX-3 showed a real writer using
// `await fs.rename(tempPath, evidencePath)` that RULE R was structurally
// blind to when it only matched the Sync form.
const RENAME_RE =
	/(?<![A-Za-z0-9_$])(?:renameSync|(?:[A-Za-z0-9_$]+\.)*rename)\s*\(/g;
const TRANSACT_RE = /(?<![A-Za-z0-9_$])transactFile\s*(?:<[^(]*>)?\s*\(/g;

/**
 * `Bun.write(` — RULE W's other direct-write head, added in round 7. It is
 * anchored on the `Bun.` RECEIVER on purpose: a bare `write` head would read the
 * payload argument of every `handle.write(data)` / `stream.write(chunk)` as a
 * path. The repo's own `bunWrite` alias (src/utils/bun-compat.ts) was already in
 * `DIRECT_WRITE_RE`, but the global it wraps was not, so a writer calling
 * `Bun.write` directly matched no rule AND no enumeration recognizer.
 */
const BUN_WRITE_RE = /(?<![A-Za-z0-9_$])Bun\.write\s*\(/g;

/**
 * RULE C call heads (round 7) — the COPY class. A copy overwrites its
 * DESTINATION (argument 2) exactly as a write does, and `cpSync(src, dest,
 * { recursive: true, force: true })` is the shape used to restore a whole
 * `.swarm/` subtree from a checkpoint.
 *
 * Deliberately NOT folded into `RENAME_RE`: `collectRenameSites` and
 * `isRenamedAwayNearby` read argument 1 of a rename as "nothing remains at this
 * path", which is false for a copy — folding the two together would turn the
 * temp-file exclusion into a fail-open.
 */
const COPY_RE =
	/(?<![A-Za-z0-9_$])(?:copyFileSync|copyFile|cpSync|cp|linkSync|link|symlinkSync|symlink)\s*\(/g;

/**
 * RULE W's in-place truncation head. `truncate(path, len)` rewrites existing
 * bytes at a path — the same-size-inside-one-tick hazard in its purest form.
 * The DESCRIPTOR forms (`ftruncate`, `ftruncateSync`) are deliberately excluded:
 * their first argument is an fd, and the path was named at the `open` that RULE
 * S already governs.
 */
const TRUNCATE_RE = /(?<![A-Za-z0-9_$])(?:truncateSync|truncate)\s*\(/g;

/**
 * RULE S call heads (round 7) — a write performed through a HANDLE rather than
 * in one call: `createWriteStream(p)` followed by `.write(chunk)`, or
 * `open(p, 'w')` / `openSync(p, 'w')` followed by `handle.write(...)` /
 * `writeSync(fd, …)`. Those subsequent calls name the handle, not the path, so
 * the path argument of the OPENING call is the only place a rule can key on.
 */
const WRITE_STREAM_RE = /(?<![A-Za-z0-9_$])createWriteStream\s*\(/g;
const OPEN_RE = /(?<![A-Za-z0-9_$])(?:openSync|open)\s*\(/g;

/**
 * True when an `open`/`openSync` flag string overwrites existing bytes.
 *
 * Read-only (`r`, `rs`) does not write at all. The APPEND family (`a`, `a+`,
 * `ax`, `as+`, …) strictly increases file size, so the stat stamp always differs
 * and the cache always misses — the same reasoning that excludes `appendFile`
 * (see DELIBERATE EXCLUSIONS). `r+` DOES fire: it rewrites in place, which is
 * precisely the same-size-inside-one-tick hazard this scan exists for.
 */
function flagOverwrites(flag: string): boolean {
	const normalized = flag.trim();
	if (normalized === '') return true;
	if (normalized.startsWith('a')) return false;
	if (normalized.startsWith('r')) return normalized.includes('+');
	return true;
}

/**
 * True when an `open`/`openSync` call opens for writing. A MISSING flag
 * argument defaults to `'r'` and does not fire; a NON-LITERAL flag DOES fire,
 * because a false positive is a report a human resolves while a false negative
 * is exactly the blindness this table exists to remove.
 */
function opensForWriting(args: readonly string[]): boolean {
	const flagArg = args[1]?.trim();
	if (!flagArg) return false;
	const literal = readQuotedLiteral(flagArg);
	if (literal !== null) return flagOverwrites(literal);
	// Keep the conservative non-literal default, but recognize the exact
	// read-only/no-follow expression used by bounded evidence readers. The exact
	// expression proves every bit is either O_RDONLY, O_NOFOLLOW, or zero. Do not
	// generalize this to arbitrary bitmasks: O_RDWR/O_WRONLY combinations and
	// opaque variables must continue to fail closed.
	const compact = flagArg.replace(/\s+/g, '');
	return (
		compact !==
		'fs.constants.O_RDONLY|((fs.constantsas{O_NOFOLLOW?:number}).O_NOFOLLOW??0)'
	);
}

/**
 * True when a `createWriteStream` call truncates. Its second argument is an
 * options object (`{ flags: 'a' }`) or an encoding string; absent, or present
 * with no literal `flags`, the default is `'w'`, which truncates.
 */
function streamTruncates(args: readonly string[]): boolean {
	const optionsArg = args[1]?.trim();
	if (!optionsArg) return true;
	const flags = /\bflags\s*:\s*(['"])([^'"]*)\1/.exec(optionsArg);
	return flags ? flagOverwrites(flags[2] as string) : true;
}

/** The rule letter reported for an unguarded write at a recognized head. */
export type WriteRule = 'R' | 'W' | 'C' | 'S';

/**
 * One recognized WRITE HEAD: a call that can create or overwrite file content,
 * plus the index of the argument carrying its DESTINATION path.
 */
interface WriteHead {
	readonly rule: WriteRule;
	/** Call-head pattern source; a fresh global RegExp is built per use. */
	readonly source: string;
	readonly pathArgIndex: number;
	/**
	 * Optional gate over the whole argument list. Only `open`/`openSync` and
	 * `createWriteStream` need it, to keep read-only opens and appends out.
	 */
	readonly applies?: (args: readonly string[]) => boolean;
}

/**
 * THE WRITE HEAD TABLE (round 7) — the single source of truth for BOTH axes of
 * this scan: the RULES in `scanFile` and the ENUMERATION in
 * `collectWriteSitesFromSource`.
 *
 * That sharing is the whole point. Through round 6 the enumeration reused the
 * two RULE recognizers as its own, so the two axes had identical blind spots: a
 * target that was merely UNRESOLVABLE landed in `EVIDENCE_WRITE_BLIND_SPOTS` and
 * failed the gate, but a head that was UNRECOGNISED vanished from resolution and
 * enumeration simultaneously — the exact double blindness the round-6 redesign
 * was built to eliminate. Round 7's review injected six unguarded
 * `.swarm/evidence/` writers into a probe file — `copyFileSync(src,
 * evidencePath)`, `cpSync(src, planPath, {force:true})`, `open(evidencePath,
 * 'w')` + `handle.write(...)`, `createWriteStream(evidencePath)` + `.write()`,
 * `await Bun.write(evidencePath, data)` and `writeFileSync(paths[i], data)` —
 * and ALL SIX left every gate green while a class-method `writeFileSync` control
 * went red.
 *
 * `ANY_WRITE_CALL_RE`, `collectWriteHelpers`, `collectWriteTargetSites` and
 * `checkExplicitInvalidation` are all derived from this table rather than
 * repeating its head set, because every one of them silently re-opens that
 * double blindness if it drifts out of sync.
 */
const WRITE_HEADS: readonly WriteHead[] = [
	{ rule: 'W', source: DIRECT_WRITE_RE.source, pathArgIndex: 0 },
	{ rule: 'W', source: BUN_WRITE_RE.source, pathArgIndex: 0 },
	{ rule: 'W', source: TRUNCATE_RE.source, pathArgIndex: 0 },
	{ rule: 'R', source: RENAME_RE.source, pathArgIndex: 1 },
	{ rule: 'C', source: COPY_RE.source, pathArgIndex: 1 },
	{
		rule: 'S',
		source: WRITE_STREAM_RE.source,
		pathArgIndex: 0,
		applies: streamTruncates,
	},
	{
		rule: 'S',
		source: OPEN_RE.source,
		pathArgIndex: 0,
		applies: opensForWriting,
	},
];

/** Number of CAPTURING groups in a pattern source. */
export function countCaptureGroups(patternSource: string): number {
	return (new RegExp(`|${patternSource}`).exec('')?.length ?? 1) - 1;
}

/**
 * The identifier-boundary lookbehind every head starts with. It is what rejects
 * `atomicWriteFile(` and `reopen(` while still accepting the member forms
 * (`fs.writeFileSync(`, `_internals.openSync(`) — `.` is not an identifier
 * character, so no head needs a member-chain prefix of its own.
 */
export const HEAD_BOUNDARY = '(?<![A-Za-z0-9_$])';

/**
 * A head source with the shared boundary stripped, so the compiled unions can
 * assert it ONCE instead of once per alternative. Measured 2026-08-11: emitting
 * six separately-anchored alternatives made the whole-tree early-out 5x slower
 * (490ms -> 2469ms over 779 files) because the engine re-evaluates the
 * lookbehind for every alternative at every position.
 */
function headBody(source: string): string {
	return source.startsWith(HEAD_BOUNDARY)
		? source.slice(HEAD_BOUNDARY.length)
		: source;
}

/** Head pattern sources, exported so a build test can assert the invariants. */
export const WRITE_HEAD_SOURCES: readonly string[] = WRITE_HEADS.map(
	(head) => head.source,
);

/**
 * Every head in ONE pass over the source. Six separate `matchAll` scans per
 * file, at three call sites each, made the whole-tree scan several times
 * slower, so the table is compiled into a single alternation whose Nth capture
 * group identifies the Nth head.
 *
 * That dispatch requires every head source to contain NO capturing group of its
 * own, and the shared-boundary factoring requires every head source to START
 * with `HEAD_BOUNDARY`. `swarm-write-cache-invalidation-scan.test.ts` asserts
 * both, so a future head written with `(a|b)` instead of `(?:a|b)` — or without
 * the boundary — fails the gate instead of silently misrouting every match
 * after it to the wrong rule and argument index.
 */
const COMBINED_HEAD_SOURCE = `${HEAD_BOUNDARY}(?:${WRITE_HEADS.map(
	(head) => `(${headBody(head.source)})`,
).join('|')})`;

/** One recognized write call site with its destination argument resolved. */
interface HeadSite {
	head: WriteHead;
	index: number;
	/** Matched call-head text, e.g. `fs.copyFileSync(`. */
	text: string;
	/** Trimmed destination-path argument. */
	target: string;
}

/**
 * Compiled once: `new RegExp` per call showed up in the whole-tree profile.
 * Because it is `g`-flagged and shared, `collectHeadSites` resets `lastIndex`
 * on entry and must run its loop to completion without re-entering itself —
 * nothing it calls (`splitCallArgs`, a head's `applies`) touches this regex.
 */
const COMBINED_HEAD_RE = new RegExp(COMBINED_HEAD_SOURCE, 'g');

/**
 * Every write call site in `source` whose head applies and which has a
 * destination argument, in source order.
 *
 * Computed ONCE per file and shared by every consumer. `splitCallArgs` is the
 * dominant per-match cost and the head table roughly quadrupled the match
 * count, so re-deriving these per rule (as the pre-round-7 code did per
 * recognizer) made the whole-tree scan several times slower.
 */
function collectHeadSites(source: string): HeadSite[] {
	const out: HeadSite[] = [];
	COMBINED_HEAD_RE.lastIndex = 0;
	let match = COMBINED_HEAD_RE.exec(source);
	for (; match !== null; match = COMBINED_HEAD_RE.exec(source)) {
		let head: WriteHead | undefined;
		let text: string | undefined;
		for (let i = 0; i < WRITE_HEADS.length; i++) {
			if (match[i + 1] === undefined) continue;
			head = WRITE_HEADS[i];
			text = match[i + 1];
			break;
		}
		if (!head || text === undefined) continue;
		const index = match.index;
		const args = splitCallArgs(source, index + text.length - 1);
		if (!args) continue;
		if (head.applies && !head.applies(args)) continue;
		const target = args[head.pathArgIndex]?.trim();
		if (!target) continue;
		out.push({ head, index, text, target });
	}
	return out;
}

const ANY_WRITE_HEAD_SOURCE = `${HEAD_BOUNDARY}(?:${WRITE_HEADS.map((head) =>
	headBody(head.source),
).join('|')})`;

/** Union of every write head — the `collectWriteHelpers` body early-out. */
const ANY_WRITE_HEAD_RE = new RegExp(ANY_WRITE_HEAD_SOURCE);

/**
 * Union of every rule's call head — the sound whole-file early-out in scanFile.
 * DERIVED from `WRITE_HEADS` so a head can never be added to the table while
 * this early-out still skips the file, which would leave the new rule dead on
 * arrival with every gate green.
 */
const ANY_WRITE_CALL_RE = new RegExp(
	`${HEAD_BOUNDARY}(?:${WRITE_HEADS.map((head) => headBody(head.source))
		.concat(headBody(TRANSACT_RE.source))
		.join('|')})`,
);

// ---------------------------------------------------------------------------
// Head-set CLOSURE (issue #1619 round 7)
// ---------------------------------------------------------------------------

/**
 * True when `<name>(` is dispatched to a rule by the compiled head matcher.
 * Probed against the real matcher rather than against the name lists below, so
 * a head whose pattern is typo'd reads as ungoverned instead of as covered.
 */
export function isGovernedWriteHead(name: string): boolean {
	return collectHeadSites(`x = ${name}(a, b, c);`).length > 0;
}

/**
 * The names `WRITE_HEADS` claims to recognize. Asserted BOTH ways against
 * `isGovernedWriteHead`, so this list cannot drift from the patterns.
 */
export const GOVERNED_WRITE_HEAD_NAMES: readonly string[] = [
	'bunWrite',
	'writeFileSync',
	'writeFile',
	'Bun.write',
	'truncate',
	'truncateSync',
	'renameSync',
	'rename',
	'copyFileSync',
	'copyFile',
	'cpSync',
	'cp',
	'linkSync',
	'link',
	'symlinkSync',
	'symlink',
	'createWriteStream',
	'openSync',
	'open',
];

export interface ExcludedWriteHead {
	readonly name: string;
	readonly reason: string;
}

/**
 * Write-capable APIs this scan deliberately does NOT govern, each with the
 * argument for why it cannot hide a stale read. Every entry is asserted to be
 * ungoverned, so an exclusion and a head can never both claim the same name.
 */
export const EXCLUDED_WRITE_HEADS: readonly ExcludedWriteHead[] = [
	{
		name: 'appendFile',
		reason:
			'An append strictly increases file size, so the stat stamp (mtime + ctime ' +
			'+ size) always differs and the cache always misses. This is the ' +
			'pre-existing DELIBERATE EXCLUSION covering ~15 events.jsonl sites.',
	},
	{
		name: 'appendFileSync',
		reason:
			'Synchronous twin of appendFile; identical size-always-grows argument.',
	},
	{
		name: 'write',
		reason:
			'Writes through an already-open DESCRIPTOR or FileHandle. The path is ' +
			'named at the `open`/`createWriteStream` that produced the handle, and ' +
			'RULE S governs that call. A bare `write` head would additionally read ' +
			'every `stream.write(chunk)` payload as a path.',
	},
	{
		name: 'writeSync',
		reason:
			'Descriptor form of `write`; the path was named at the governed open.',
	},
	{
		name: 'writev',
		reason:
			'Descriptor form of `write`; the path was named at the governed open.',
	},
	{
		name: 'writevSync',
		reason:
			'Descriptor form of `write`; the path was named at the governed open.',
	},
	{
		name: 'ftruncate',
		reason:
			'Descriptor form of `truncate` — argument 1 is an fd, not a path, and the ' +
			'path was named at the `open` RULE S governs.',
	},
	{
		name: 'ftruncateSync',
		reason:
			'Descriptor form of `truncate`; the path was named at the governed open.',
	},
	{
		name: 'unlink',
		reason:
			'A deletion. Once the file is gone `getStamp` returns null, the cached ' +
			'readers bypass the cache and call readText(), so a leftover entry for a ' +
			'deleted path is unreachable and needs no invalidation.',
	},
	{
		name: 'unlinkSync',
		reason: 'Deletion; identical null-stamp argument as unlink.',
	},
	{ name: 'rm', reason: 'Deletion; identical null-stamp argument as unlink.' },
	{
		name: 'rmSync',
		reason: 'Deletion; identical null-stamp argument as unlink.',
	},
	{
		name: 'rmdir',
		reason:
			'Removes a DIRECTORY. Any artifact inside it is gone too, which is the ' +
			'null-stamp case above; the directory itself is never a cached artifact.',
	},
	{ name: 'rmdirSync', reason: 'Directory removal; same argument as rmdir.' },
	{
		name: 'mkdir',
		reason:
			'Creates a DIRECTORY and never file content. Cached artifacts are files; ' +
			'no cached reader is ever handed a directory path.',
	},
	{ name: 'mkdirSync', reason: 'Directory creation; same argument as mkdir.' },
	{
		name: 'mkdtemp',
		reason:
			'Creates a fresh, uniquely-named temp DIRECTORY. The name did not exist ' +
			'before the call, so no cache entry can be keyed on it.',
	},
	{
		name: 'mkdtempSync',
		reason: 'Unique temp directory creation; same argument as mkdtemp.',
	},
	{
		name: 'opendir',
		reason:
			'Opens a DIRECTORY for enumeration. It mutates nothing and yields no ' +
			'file content.',
	},
	{
		name: 'opendirSync',
		reason: 'Directory enumeration; same argument as opendir.',
	},
	{
		name: 'utimes',
		reason:
			'Metadata only. It CHANGES mtime, which makes the stat stamp differ and ' +
			'the cache MISS — the safe direction. It never changes file content.',
	},
	{
		name: 'utimesSync',
		reason: 'Timestamp metadata only; same argument as utimes.',
	},
	{
		name: 'futimes',
		reason: 'Timestamp metadata on a descriptor; same argument as utimes.',
	},
	{
		name: 'futimesSync',
		reason: 'Timestamp metadata on a descriptor; same argument as utimes.',
	},
	{
		name: 'lutimes',
		reason: 'Timestamp metadata on a symlink; same argument as utimes.',
	},
	{
		name: 'lutimesSync',
		reason: 'Timestamp metadata on a symlink; same argument as utimes.',
	},
	{
		name: 'chmod',
		reason:
			'Permission metadata only. It changes ctime, so the stamp differs and the ' +
			'cache misses; file content is untouched.',
	},
	{
		name: 'chmodSync',
		reason: 'Permission metadata only; same argument as chmod.',
	},
	{
		name: 'fchmod',
		reason: 'Permission metadata on a descriptor; same argument as chmod.',
	},
	{
		name: 'fchmodSync',
		reason: 'Permission metadata on a descriptor; same argument as chmod.',
	},
	{
		name: 'lchmod',
		reason: 'Permission metadata on a symlink; same argument as chmod.',
	},
	{
		name: 'chown',
		reason:
			'Ownership metadata only; changes ctime, never content. Same as chmod.',
	},
	{
		name: 'chownSync',
		reason: 'Ownership metadata only; same argument as chown.',
	},
	{
		name: 'lchown',
		reason: 'Ownership metadata on a symlink; same argument as chown.',
	},
];

/**
 * The file-mutating surface of `node:fs` / `node:fs/promises` plus Bun's global
 * writer. This is the UNIVERSE the closure test checks: every one of these
 * names that is actually CALLED in src/ must be either a governed head or a
 * reasoned exclusion.
 *
 * It is a hand-maintained list of a documented standard-library API, which is
 * the honest bound on the claim — a repo-local write helper (`atomicWriteFile`,
 * `renameWithRetry`) or a shelled-out `cp` is outside it, and is covered, if at
 * all, by RULES H/T instead.
 */
export const FILE_MUTATING_APIS: readonly string[] = [
	...GOVERNED_WRITE_HEAD_NAMES,
	...EXCLUDED_WRITE_HEADS.map((entry) => entry.name),
];

/**
 * `FILE_MUTATING_APIS` names that appear as a CALL somewhere in src/. One
 * combined pass; the per-name loop was the slowest thing in the suite.
 */
export function collectUsedFileMutatingApis(): Set<string> {
	const alternation = [...FILE_MUTATING_APIS]
		.map((name) => name.replace('.', '\\.'))
		.sort((a, b) => b.length - a.length)
		.join('|');
	const re = new RegExp(`${HEAD_BOUNDARY}(${alternation})\\s*\\(`, 'g');
	const used = new Set<string>();
	for (const rel of listSourceFiles()) {
		const source = blankComments(readFileSync(join(REPO_ROOT, rel), 'utf-8'));
		for (const match of source.matchAll(re)) used.add(match[1] as string);
	}
	return used;
}

const FUNCTION_BOUNDARY_RE =
	/^(?:export\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:const|let)\s+\w+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\()/;

const DECLARATION_RE =
	/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=;]*)?=\s*/g;

/** Bare `name = <rhs>` assignment — see `collectBindingSites`. */
const ASSIGNMENT_RE = /(?:^|[;{}\n)])\s*([A-Za-z0-9_$]+)\s*=(?![=>])\s*/g;

const FORWARD_WINDOW = 25;

function listSourceFiles(): string[] {
	const entries = readdirSync(SRC_DIR, { recursive: true }) as string[];
	return entries
		.filter((rel) => rel.endsWith('.ts'))
		.filter((rel) => !rel.endsWith('.test.ts') && !rel.endsWith('.spec.ts'))
		.map((rel) => join('src', rel));
}

/** Repo-relative path with forward slashes, so registry keys are portable. */
function toPosixRel(relPath: string): string {
	return relPath.split('\\').join('/');
}

type ScanMode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 'regex';

/**
 * Tokens after which a `/` begins a REGEX LITERAL rather than a division. The
 * classic ambiguity; this is the standard "previous significant token" rule and
 * it is exact for the formatted TypeScript this repo produces.
 */
const REGEX_PRECEDER_RE =
	/(?:[({[,;:=!&|?+\-*%~^<>]|(?:^|[^A-Za-z0-9_$])(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await))\s*$/;

export interface BlankedSource {
	text: string;
	/**
	 * The lexer state at end of input. Anything other than `'code'` means the
	 * scan lost sync and every check downstream of that point is unreliable.
	 */
	terminalMode: ScanMode;
}

/**
 * Blank out comment bodies while preserving every newline, so line numbers in
 * violation reports still match the real file and prose describing the rule
 * (`"call invalidateCachedArtifact(x) after the rename"`) can neither satisfy
 * nor trip a check. String and template literals are left intact — the scan
 * needs the filename literals inside them.
 *
 * REGEX LITERALS are tracked too (round 6). Without that, a regex containing an
 * odd number of backticks — `src/tools/completion-verify.ts` has one — flips the
 * template-literal parity and leaves the lexer in `tpl` mode to end of file, so
 * every comment after it stays UNBLANKED and commented-out prose can satisfy a
 * check. `blankedSource().terminalMode` exposes the desync, and
 * tests/unit/build/swarm-write-cache-invalidation-scan.test.ts ('the comment
 * blanker ends in code state for every file in src/') asserts it is `'code'` for
 * every file in src/, which turns any future lexer gap from silent into loud.
 * (Round 7 correction: this docblock and the KNOWN LIMITATIONS entry both used
 * to name swarm-write-cache-evidence-class.test.ts, which has never contained
 * that assertion.)
 */
export function blankedSource(source: string): BlankedSource {
	let out = '';
	let i = 0;
	let mode: ScanMode = 'code';
	// Character-class depth inside a regex literal: `/` inside `[...]` is literal.
	let inCharClass = false;
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (mode === 'code') {
			if (ch === '/' && next === '/') {
				mode = 'line';
				out += '  ';
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				mode = 'block';
				out += '  ';
				i += 2;
				continue;
			}
			if (ch === '/' && REGEX_PRECEDER_RE.test(out)) {
				mode = 'regex';
				inCharClass = false;
				out += ch;
				i++;
				continue;
			}
			if (ch === "'") mode = 'sq';
			else if (ch === '"') mode = 'dq';
			else if (ch === '`') mode = 'tpl';
			out += ch;
			i++;
			continue;
		}
		if (mode === 'line') {
			if (ch === '\n') {
				mode = 'code';
				out += ch;
			} else out += ' ';
			i++;
			continue;
		}
		if (mode === 'block') {
			if (ch === '*' && next === '/') {
				mode = 'code';
				out += '  ';
				i += 2;
				continue;
			}
			out += ch === '\n' ? ch : ' ';
			i++;
			continue;
		}
		if (mode === 'regex') {
			out += ch;
			if (ch === '\\') {
				if (i + 1 < source.length) out += source[i + 1];
				i += 2;
				continue;
			}
			// An unterminated regex cannot span a line; bail back to code so one
			// misclassified division cannot swallow the rest of the file.
			if (ch === '\n') mode = 'code';
			else if (ch === '[') inCharClass = true;
			else if (ch === ']') inCharClass = false;
			else if (ch === '/' && !inCharClass) mode = 'code';
			i++;
			continue;
		}
		// inside a string/template literal
		out += ch;
		if (ch === '\\') {
			if (i + 1 < source.length) out += source[i + 1];
			i += 2;
			continue;
		}
		if (
			(mode === 'sq' && ch === "'") ||
			(mode === 'dq' && ch === '"') ||
			(mode === 'tpl' && ch === '`')
		) {
			mode = 'code';
		}
		i++;
	}
	// A line comment that runs to EOF without a trailing newline is closed, not
	// a desync.
	if (mode === 'line') mode = 'code';
	return { text: out, terminalMode: mode };
}

function blankComments(source: string): string {
	return blankedSource(source).text;
}

/** Repo-relative paths of every scanned src/ file — used by the lexer invariant. */
export function listScannedSourceFiles(): string[] {
	return listSourceFiles().map(toPosixRel);
}

/** Raw text of a scanned src/ file, for tests that need to re-lex it. */
export function readScannedSource(relPath: string): string {
	return readFileSync(join(REPO_ROOT, relPath), 'utf-8');
}

/**
 * Split the argument list of a call whose `(` sits at `openIndex`. Tracks
 * paren/bracket/brace depth and string literals so `path.join(a, b)` nested in
 * argument 1 does not corrupt the split. Returns null on an unbalanced call.
 */
function splitCallArgs(source: string, openIndex: number): string[] | null {
	const args: string[] = [];
	let depth = 0;
	let current = '';
	let quote: string | null = null;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i] as string;
		if (quote) {
			current += ch;
			if (ch === '\\') {
				current += source[i + 1] ?? '';
				i++;
			} else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') {
			depth++;
			if (depth === 1) continue;
		} else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) {
				args.push(current.trim());
				return args;
			}
		} else if (ch === ',' && depth === 1) {
			args.push(current.trim());
			current = '';
			continue;
		}
		current += ch;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Pattern engine
// ---------------------------------------------------------------------------

interface VarPattern {
	/** Source offset of the declaration, used for nearest-preceding lookup. */
	index: number;
	pattern: string;
}

/** A same-file `function f(...) { return <expr>; }` path producer. */
interface ReturnProducer {
	/** The returned expression, `return`/`;` stripped. */
	expr: string;
	/** Source offset of the `return`, used as `beforeIndex` inside the body. */
	index: number;
}

interface PatternCtx {
	vars: Map<string, VarPattern[]>;
	/** Same-file single-return path producers, keyed by function name. */
	returns: Map<string, ReturnProducer>;
	beforeIndex: number;
	/** Producers currently being expanded — the recursion guard. */
	expanding: ReadonlySet<string>;
}

const NO_EXPANSION: ReadonlySet<string> = new Set<string>();

function lookupVarPattern(ctx: PatternCtx, name: string): string | null {
	const entries = ctx.vars.get(name);
	if (!entries) return null;
	let best: VarPattern | null = null;
	for (const entry of entries) {
		if (entry.index > ctx.beforeIndex) continue;
		if (!best || entry.index > best.index) best = entry;
	}
	return best ? best.pattern : null;
}

/**
 * Index of the bracket that closes the one at `openIndex`, or -1. Shares
 * `splitCallArgs`'s quote handling so a `)` or `}` inside a string literal
 * cannot end the span early.
 */
function matchingClose(source: string, openIndex: number): number {
	let depth = 0;
	let quote: string | null = null;
	for (let i = openIndex; i < source.length; i++) {
		const ch = source[i] as string;
		if (quote) {
			if (ch === '\\') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === '`') {
			quote = ch;
			continue;
		}
		if (ch === '(' || ch === '[' || ch === '{') depth++;
		else if (ch === ')' || ch === ']' || ch === '}') {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/**
 * Every same-file `function name(...) { return <expr>; }`. Only a body that is
 * EXACTLY one return statement qualifies — anything with a second statement is
 * skipped rather than guessed at. This is what makes `phaseEvidencePath(...)`
 * (src/tools/submit-phase-council-verdicts.ts:367) and the two-hop
 * `phaseEvidencePath -> leanTurboEvidenceDir` chain (src/turbo/lean/evidence.ts)
 * resolvable; before round 6 they folded to null and their writers were
 * invisible to every rule.
 */
/** A same-file `function` declaration, with its parameter names and body. */
interface FunctionDecl {
	name: string;
	/** Declared parameter names, in order; destructured params become ''. */
	params: string[];
	body: string;
	/** Source offset of the body's opening brace. */
	bodyIndex: number;
	/** Source offset of the body's closing brace. */
	bodyEnd: number;
}

function collectFunctions(source: string): FunctionDecl[] {
	const functions: FunctionDecl[] = [];
	const collect = (re: RegExp, requireArrow: boolean): void => {
		for (const match of source.matchAll(re)) {
			const name = match[1] as string;
			const parenIndex =
				(match.index as number) + (match[0] as string).length - 1;
			const parenClose = matchingClose(source, parenIndex);
			if (parenClose < 0) continue;
			const braceIndex = source.indexOf('{', parenClose);
			if (braceIndex < 0) continue;
			const between = source.slice(parenClose + 1, braceIndex);
			// A return type annotation may itself contain braces (`): { a: string } {`).
			// A `;` between the parameter list and the brace means this is an overload
			// signature or an interface member, not a body.
			if (between.includes(';')) continue;
			// An arrow head must really be an arrow, or `const x = (a || b) && cond`
			// would parse as one. The converse test — "a `function` head never has
			// `=>` before its body" — was WRONG and silently dropped every function
			// whose RETURN TYPE contains an arrow: `async function acquireLock(p:
			// string): Promise<() => void> {` (src/tools/sast-baseline.ts) was not a
			// FunctionDecl at all, so RULE H could not govern its `openSync(p, 'wx')`
			// write. The `function` keyword is already proof of the shape.
			if (requireArrow && !between.includes('=>')) continue;
			const braceClose = matchingClose(source, braceIndex);
			if (braceClose < 0) continue;
			const params = (splitCallArgs(source, parenIndex) ?? [])
				.map((raw) => /^([A-Za-z0-9_$]+)/.exec(raw.trim())?.[1] ?? '')
				.map((param) => (param === 'readonly' ? '' : param));
			functions.push({
				name,
				params,
				body: source.slice(braceIndex + 1, braceClose),
				bodyIndex: braceIndex,
				bodyEnd: braceClose,
			});
		}
	};
	collect(new RegExp(FUNCTION_DECL_RE.source, 'g'), false);
	collect(new RegExp(ARROW_DECL_RE.source, 'g'), true);
	return functions;
}

function collectSingleReturnProducers(
	functions: readonly FunctionDecl[],
): Map<string, ReturnProducer> {
	const producers = new Map<string, ReturnProducer>();
	for (const fn of functions) {
		const body = fn.body.trim();
		if (!/^return\b/.test(body)) continue;
		let expr = body.slice('return'.length).trim();
		if (expr.endsWith(';')) expr = expr.slice(0, -1).trim();
		if (expr.length === 0 || expr.includes(';')) continue;
		if (/(?<![A-Za-z0-9_$])return(?![A-Za-z0-9_$])/.test(expr)) continue;
		producers.set(fn.name, { expr, index: fn.bodyIndex });
	}
	return producers;
}

/**
 * A same-file function that writes to one of its own PARAMETERS — the shape
 * `atomicWriteJson(filePath, data)` in src/turbo/lean/evidence.ts:174, whose
 * body renames a temp file onto `filePath`. Before round 6 this was the
 * documented dead end: "a WRITER that receives its target path as a function
 * PARAMETER is not statically resolvable, so it is invisible to RULES R and W".
 * RULE H closes it for same-file helpers exactly the way RULE T closes
 * `transactFile` — resolve the callee, then require the invalidation to live in
 * the callee's body, keyed on the same parameter.
 */
interface WriteHelper {
	name: string;
	/** Index of the parameter the helper writes to. */
	paramIndex: number;
	paramName: string;
	body: string;
	/** Offset of the write call WITHIN `body`; the invalidation must follow it. */
	writeIndex: number;
	bodyIndex: number;
	bodyEnd: number;
}

function collectWriteHelpers(
	functions: readonly FunctionDecl[],
): Map<string, WriteHelper> {
	const helpers = new Map<string, WriteHelper>();
	for (const fn of functions) {
		if (fn.params.length === 0) continue;
		// Cheap early-out: arrow-function support multiplied the candidate count,
		// and most bodies contain no write at all. Derived from WRITE_HEADS in
		// lockstep with `consider` below — a head present in one and not the other
		// would make the helper's body invisible to RULE H while
		// `collectWriteSitesFromSource` still suppressed it as "already governed".
		if (!ANY_WRITE_HEAD_RE.test(fn.body)) continue;
		let found: number | null = null;
		let writeAt = -1;
		// Head-table PRIORITY order, then source order within a head: a
		// temp-then-rename helper must key on the rename's destination parameter,
		// not on the earlier `bunWrite(tempPath, …)`.
		const sites = collectHeadSites(fn.body);
		for (const head of WRITE_HEADS) {
			for (const site of sites) {
				if (site.head !== head) continue;
				const at = fn.params.indexOf(site.target);
				if (at < 0) continue;
				found = at;
				writeAt = site.index;
				break;
			}
			if (found !== null) break;
		}
		if (found === null) continue;
		helpers.set(fn.name, {
			name: fn.name,
			paramIndex: found,
			paramName: fn.params[found] as string,
			body: fn.body,
			writeIndex: writeAt,
			bodyIndex: fn.bodyIndex,
			bodyEnd: fn.bodyEnd,
		});
	}
	return helpers;
}

/** Body of a leading `'…'` / `"…"` literal, or null if `text` is not one. */
function readQuotedLiteral(text: string): string | null {
	const quote = text[0];
	if (quote !== "'" && quote !== '"') return null;
	let out = '';
	for (let i = 1; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === '\\') {
			out += text[i + 1] ?? '';
			i++;
			continue;
		}
		if (ch === quote) return out;
		if (ch === '\n') return null;
		out += ch;
	}
	return null;
}

/** Body of a leading `` `…` `` template literal, or null. */
function readTemplateBody(text: string): string | null {
	if (text[0] !== '`') return null;
	for (let i = 1; i < text.length; i++) {
		const ch = text[i] as string;
		if (ch === '\\') {
			i++;
			continue;
		}
		if (ch === '`') return text.slice(1, i);
	}
	return null;
}

/**
 * Fold a template literal body to a pattern. `${IDENT}` is replaced by IDENT's
 * own resolved pattern when there is one — this is what turns
 * `` `${DRIFT_REPORT_PREFIX}${report.phase}.json` `` into the SPECIFIC
 * `drift-report-phase-*.json` instead of the floody `*.json`. Everything else
 * becomes `*`.
 */
function templateToPattern(body: string, ctx: PatternCtx): string {
	return body.replace(/\$\{([^{}]*)\}/g, (_full, rawExpr: string) => {
		const ident = rawExpr.trim();
		if (/^[A-Za-z0-9_$]+$/.test(ident)) {
			const resolved = lookupVarPattern(ctx, ident);
			if (resolved !== null) return resolved;
		}
		return WILDCARD;
	});
}

/**
 * Fold an expression to a `UNIT_SEP`-joined path pattern, or null when the
 * expression is not a shape this scan can represent (a bare parameter, a
 * `.replace()` chain, a `for…of` binding). Null at a reader call site means the
 * site must be registered in `UNRESOLVED_READER_REGISTRY`.
 */
function resolvePattern(expr: string, ctx: PatternCtx): string | null {
	const text = expr.trimStart();
	if (text.startsWith("'") || text.startsWith('"')) {
		return readQuotedLiteral(text);
	}
	if (text.startsWith('`')) {
		const body = readTemplateBody(text);
		return body === null ? null : templateToPattern(body, ctx);
	}
	if (PATH_PRODUCER_RE.test(text)) {
		const args = splitCallArgs(text, text.indexOf('('));
		if (!args) return null;
		return (
			args
				// A trailing comma in a multi-line call yields an empty final
				// argument. Folding it to `*` appended a phantom path segment, which
				// made a resolvable target (`.swarm/evidence/<id>.json`) look wholly
				// dynamic.
				.filter((arg) => arg.trim().length > 0)
				.map((arg) => resolvePattern(arg, ctx) ?? WILDCARD)
				.join(UNIT_SEP)
		);
	}
	const trimmed = text.trim();
	if (/^[A-Za-z0-9_$]+$/.test(trimmed)) return lookupVarPattern(ctx, trimmed);
	const localCall = LOCAL_CALL_RE.exec(text);
	if (localCall) {
		const callee = localCall[1] as string;
		const producer = ctx.returns.get(callee);
		if (!producer || ctx.expanding.has(callee)) return null;
		return resolvePattern(producer.expr, {
			...ctx,
			beforeIndex: producer.index,
			expanding: new Set([...ctx.expanding, callee]),
		});
	}
	return null;
}

/**
 * Split a pattern into path units and drop the leading base-directory noise
 * (`directory`, `.swarm`). Interior wildcard units are PRESERVED: dropping them
 * would make `evidence/<id>/evidence.json` look like `evidence/<id>.json`, two
 * genuinely different artifacts.
 */
function toUnits(pattern: string): string[] {
	const units = pattern
		.split(UNIT_SEP)
		.map((unit) =>
			unit
				.split('/')
				.map((seg) => seg.trim())
				.filter((seg) => seg.length > 0 && seg !== '.')
				.map((seg) => seg.replace(/\*{2,}/g, WILDCARD)),
		)
		.filter((segs) => segs.length > 0);
	while (units.length > 0) {
		const first = units[0] as string[];
		let i = 0;
		while (
			i < first.length &&
			(first[i] === WILDCARD || first[i] === '.swarm')
		) {
			i++;
		}
		if (i === first.length) {
			units.shift();
			continue;
		}
		units[0] = first.slice(i);
		break;
	}
	return units.map((segs) => segs.join('/'));
}

function hasLiteralRun(text: string): boolean {
	return /[^*/]{2,}/.test(text);
}

/**
 * A name is specific enough to enter the cached set when its basename stem
 * carries a literal run of at least two characters, or — failing that — one of
 * its directory segments is FULLY literal and carries such a run. `*.json`,
 * `.json`, `*` and `*.json/*` are NOT specific: admitting any of them would
 * make the write-side matcher fire on nearly every JSON write in src/. The
 * "fully literal directory" requirement is what rejects `*.json/*`, whose only
 * literal content is an extension inside a wildcard segment.
 */
export function isSpecificName(name: string): boolean {
	if (name.length === 0) return false;
	const segs = name.split('/');
	const base = segs[segs.length - 1] as string;
	const stem = base.replace(/\.[A-Za-z0-9]+$/, '');
	if (hasLiteralRun(stem)) return true;
	return segs
		.slice(0, -1)
		.some((seg) => !seg.includes(WILDCARD) && hasLiteralRun(seg));
}

/**
 * The trailing unit, qualified with as many preceding units as it takes to
 * become specific. Returns null when no prefix makes it specific, and
 * immediately when the BASENAME itself is wholly dynamic: qualifying `*` with a
 * directory yields `evidence/*`, which names no artifact and would match every
 * write under that directory. Such a reader belongs in
 * `UNRESOLVED_READER_REGISTRY`, where a human states what it actually reads.
 */
function harvestName(units: string[]): string | null {
	if (units.length === 0) return null;
	const lastUnit = units[units.length - 1] as string;
	const lastSegs = lastUnit.split('/');
	const basename = lastSegs[lastSegs.length - 1] as string;
	if (!/[^*]/.test(basename)) return null;
	let acc = lastUnit;
	let i = units.length - 2;
	while (!isSpecificName(acc)) {
		if (i < 0) return null;
		acc = `${units[i] as string}/${acc}`;
		i--;
	}
	return acc;
}

function segmentToRegex(segment: string): RegExp {
	const body = segment
		.split(WILDCARD)
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('[^/]*');
	return new RegExp(`^${body}$`);
}

/** `**` in a cached pattern: "this directory and everything below it". */
const RECURSIVE_WILDCARD = '**';

function segmentsMatch(cachedSeg: string, writeSeg: string): boolean {
	const subject = writeSeg.split(WILDCARD).join(WRITE_WILDCARD_SENTINEL);
	return segmentToRegex(cachedSeg).test(subject);
}

/**
 * True when `cachedName` (the matcher, wildcards allowed) covers the trailing
 * segments of `writePattern` (the subject). One-directional by design: a
 * wildcard in the WRITE path is replaced by a sentinel that no literal cached
 * segment can match, so a write of `` `${x}.json` `` never matches the cached
 * literal `plan.json`, while a write of
 * `` `${DRIFT_REPORT_PREFIX}${n}.json` `` does match the cached pattern
 * `drift-report-phase-*.json`.
 *
 * A cached name whose LAST segment is `**` (`evidence/**`) switches to
 * PREFIX-anchored, directory-recursive matching instead: the segments before
 * the `**` must match somewhere in `writePattern`, and at least one further
 * segment must follow. That is the shape used to close a whole artifact
 * DIRECTORY (issue #1619 round 6) rather than a single artifact name, and it
 * deliberately over-approximates — `.swarm/evidence/<anything>` is covered
 * whatever its depth, so a new evidence layout cannot escape the guard the way
 * `evidence/<phase>/drift-verifier.json` escaped `evidence/*.json`. Only the
 * trailing form is accepted; `resolveRegistryPatterns` rejects any other
 * placement so a malformed pattern fails loudly instead of matching nothing.
 */
export function cachedNameMatchesPath(
	cachedName: string,
	writePattern: string,
): boolean {
	const cachedSegs = cachedName.split('/').filter((seg) => seg.length > 0);
	const writeSegs = writePattern.split('/').filter((seg) => seg.length > 0);
	if (cachedSegs.length === 0) return false;
	if (cachedSegs[cachedSegs.length - 1] === RECURSIVE_WILDCARD) {
		const prefix = cachedSegs.slice(0, -1);
		if (prefix.length === 0) return false;
		for (let start = 0; start + prefix.length < writeSegs.length; start++) {
			let ok = true;
			for (let i = 0; i < prefix.length; i++) {
				if (
					!segmentsMatch(prefix[i] as string, writeSegs[start + i] as string)
				) {
					ok = false;
					break;
				}
			}
			if (ok) return true;
		}
		return false;
	}
	if (cachedSegs.length > writeSegs.length) return false;
	const tail = writeSegs.slice(writeSegs.length - cachedSegs.length);
	for (let i = 0; i < cachedSegs.length; i++) {
		if (!segmentsMatch(cachedSegs[i] as string, tail[i] as string))
			return false;
	}
	return true;
}

/** One `name = <rhs>` binding site: a declaration OR a bare assignment. */
interface BindingSite {
	name: string;
	/** Source offset of the binding. */
	index: number;
	/** Source offset where the right-hand side starts. */
	rhsStart: number;
}

/**
 * Every place a name is bound to an expression, in source order: `const`/`let`/
 * `var` declarations WITH an initializer, plus bare `name = <rhs>` assignments.
 * The assignment half closes the round-6 finding-4 shape — `let validatedPath:
 * string;` followed by `validatedPath = validateSwarmPath(...)`
 * (src/tools/write-drift-evidence.ts:126-127) — which `DECLARATION_RE` cannot
 * see because it requires the `=` to be part of the declaration. The
 * `(?:^|[;{}\n)])` prefix and the `(?![=>])` lookahead keep it off `==`, `>=`,
 * `+=`, `=>` and member assignments (`obj.prop =`).
 */
function collectBindingSites(source: string): BindingSite[] {
	const sites: BindingSite[] = [];
	for (const match of source.matchAll(DECLARATION_RE)) {
		const index = match.index as number;
		sites.push({
			name: match[1] as string,
			index,
			rhsStart: index + (match[0] as string).length,
		});
	}
	for (const match of source.matchAll(ASSIGNMENT_RE)) {
		const index = match.index as number;
		sites.push({
			name: match[1] as string,
			index,
			rhsStart: index + (match[0] as string).length,
		});
	}
	return sites.sort((a, b) => a.index - b.index);
}

/**
 * Table of every binding in a file whose right-hand side folds to a path
 * pattern. Built in source order, so a binding that references an earlier one
 * resolves transitively through `lookupVarPattern`; chains of any length work
 * because every hop was already recorded.
 */
function buildVarPatterns(
	source: string,
	returns: Map<string, ReturnProducer>,
): Map<string, VarPattern[]> {
	const vars = new Map<string, VarPattern[]>();
	for (const site of collectBindingSites(source)) {
		const pattern = resolvePattern(source.slice(site.rhsStart), {
			vars,
			returns,
			beforeIndex: site.index,
			expanding: NO_EXPANSION,
		});
		if (pattern === null) continue;
		const list = vars.get(site.name) ?? [];
		list.push({ index: site.index, pattern });
		vars.set(site.name, list);
	}
	return vars;
}

/** Everything `resolvePattern` and the write rules need for one file. */
interface FileTables {
	vars: Map<string, VarPattern[]>;
	returns: Map<string, ReturnProducer>;
	writeHelpers: Map<string, WriteHelper>;
}

function buildFileTables(source: string): FileTables {
	const functions = collectFunctions(source);
	const returns = collectSingleReturnProducers(functions);
	return {
		vars: buildVarPatterns(source, returns),
		returns,
		writeHelpers: collectWriteHelpers(functions),
	};
}

function fileCtx(tables: FileTables, beforeIndex: number): PatternCtx {
	return {
		vars: tables.vars,
		returns: tables.returns,
		beforeIndex,
		expanding: NO_EXPANSION,
	};
}

/** The write path a target expression names, or null when it does not fold. */
function writePathOf(expr: string, ctx: PatternCtx): string | null {
	const pattern = resolvePattern(expr, ctx);
	if (pattern === null) return null;
	const writePath = toUnits(pattern).join('/');
	return writePath.length > 0 ? writePath : null;
}

// ---------------------------------------------------------------------------
// Write-side rules
// ---------------------------------------------------------------------------

interface Declaration {
	line: number;
	filename: string;
}

/**
 * Resolve `const X = <path producer>(…)` / `const X = \`…\`` declarations to
 * the cached artifact they point at. Two matchers run and their results are
 * unioned:
 *
 *   1. the ORIGINAL literal matcher — a cached name appearing verbatim as a
 *      quoted argument of a path producer, or bare inside a template literal.
 *      Preserved unchanged so no shape covered before round 5 can regress;
 *   2. the pattern matcher — the declaration is folded to a path pattern and a
 *      cached name must cover its trailing segments. This is what sees
 *      `` `${DRIFT_REPORT_PREFIX}${report.phase}.json` ``.
 *
 * Followed by the original transitive fallback, which inherits an already
 * resolved variable's artifact through a bare-identifier argument.
 */
function collectDeclarations(
	source: string,
	orderedCached: readonly string[],
	tables: FileTables,
): Map<string, Declaration[]> {
	const decls = new Map<string, Declaration[]>();
	for (const site of collectBindingSites(source)) {
		const varName = site.name;
		const declIndex = site.index;
		const rhs = source.slice(site.rhsStart);
		const line = source.slice(0, declIndex).split('\n').length;
		let statement: string | null = null;
		let args: string[] | null = null;
		// A template literal RHS (`${swarmDir}/context.md`) embeds the filename
		// bare, so it is matched without surrounding quotes; a path-producer call
		// embeds it as a quoted argument.
		let bareMatch = false;
		if (PATH_PRODUCER_RE.test(rhs)) {
			args = splitCallArgs(rhs, rhs.indexOf('('));
			statement = args ? args.join(',') : null;
		} else if (rhs.startsWith('`')) {
			const end = rhs.indexOf('`', 1);
			statement = end > 0 ? rhs.slice(0, end + 1) : null;
			bareMatch = true;
		}
		let matchedFilename: string | null = null;
		if (statement) {
			for (const name of orderedCached) {
				if (name.includes(WILDCARD)) continue;
				const hit = bareMatch
					? statement.includes(name)
					: statement.includes(`'${name}'`) || statement.includes(`"${name}"`);
				if (hit) {
					matchedFilename = name;
					break;
				}
			}
		}
		// Pattern matcher — sees interpolated and otherwise dynamic targets that
		// carry no verbatim literal (issue #1619 round 5).
		if (!matchedFilename) {
			const writePath = writePathOf(rhs, fileCtx(tables, declIndex));
			if (writePath !== null) {
				for (const name of orderedCached) {
					if (cachedNameMatchesPath(name, writePath)) {
						matchedFilename = name;
						break;
					}
				}
			}
		}
		// Transitive resolution: `evidencePath = validateSwarmPath(directory,
		// relativePath)` carries no filename literal of its own — the literal
		// lives two hops back, on `relativePath = path.join('evidence', id,
		// 'evidence.json')`. When none of this declaration's own arguments is a
		// quoted/bare literal, check whether any BARE-IDENTIFIER argument is
		// itself already a resolved cached-artifact variable (declared earlier
		// in file order, which is how this loop processes matches) and, if so,
		// inherit its filename.
		if (!matchedFilename && !bareMatch && args) {
			for (const rawArg of args) {
				const arg = rawArg.trim();
				if (!/^[A-Za-z0-9_$]+$/.test(arg)) continue;
				const candidates = decls.get(arg);
				if (!candidates) continue;
				const prior = candidates.filter((d) => d.line <= line);
				if (prior.length === 0) continue;
				const best = prior.reduce((a, b) => (b.line > a.line ? b : a));
				matchedFilename = best.filename;
				break;
			}
		}
		if (!matchedFilename) continue;
		const list = decls.get(varName) ?? [];
		list.push({ line, filename: matchedFilename });
		decls.set(varName, list);
	}
	return decls;
}

function enclosingFunctionStart(lines: string[], lineIndex: number): number {
	for (let i = lineIndex; i >= 0; i--) {
		if (FUNCTION_BOUNDARY_RE.test((lines[i] ?? '').trimStart())) return i;
	}
	return 0;
}

/**
 * True if `varName` resolves to a cached artifact filename declared at or
 * before `lineIndex` within the enclosing function body. Returns the filename
 * so violation reports name the artifact at risk.
 */
function resolveCachedTarget(
	decls: Map<string, Declaration[]>,
	lines: string[],
	varName: string,
	lineIndex: number,
): string | null {
	const candidates = decls.get(varName);
	if (!candidates) return null;
	const start = enclosingFunctionStart(lines, lineIndex);
	let best: Declaration | null = null;
	for (const decl of candidates) {
		if (decl.line - 1 > lineIndex) continue;
		if (decl.line - 1 < start) continue;
		if (!best || decl.line > best.line) best = decl;
	}
	// Fall back to any earlier declaration when the function-boundary heuristic
	// cannot see one (nested closures, object-literal methods). Being generous
	// here only ever ADDS coverage; a false positive is fixed by adding the
	// invalidation call, which is never wrong.
	if (!best) {
		for (const decl of candidates) {
			if (decl.line - 1 > lineIndex) continue;
			if (!best || decl.line > best.line) best = decl;
		}
	}
	return best ? best.filename : null;
}

/**
 * True when `invalidateCachedArtifact(<targetVar>)` appears in the forward
 * window. The argument must be the WHOLE argument: matching `line.includes(
 * targetVar)` let `invalidateCachedArtifact(pOther)` satisfy a write to `p`
 * (#1619 round 6 review finding 6), and this check guards most of the shipped
 * invalidations.
 */
/**
 * One `invalidateCachedArtifact(<arg>)` call site, precomputed per file. Every
 * coverage check consults this list instead of re-scanning the whole source,
 * which is what keeps the whole-tree scan linear rather than quadratic.
 */
interface InvalidationSite {
	index: number;
	line: number;
	arg: string;
}

function collectInvalidationSites(
	source: string,
	lineOfIndex: (index: number) => number,
): InvalidationSite[] {
	const sites: InvalidationSite[] = [];
	for (const match of source.matchAll(INVALIDATE_CALL_RE)) {
		const index = match.index as number;
		const arg = splitCallArgs(source, index + match[0].length - 1)?.[0];
		if (!arg) continue;
		sites.push({
			index,
			line: lineOfIndex(index) - 1,
			arg: normalizeExpr(arg),
		});
	}
	return sites;
}

/** One rename call site (source, destination), precomputed per file. */
interface RenameSite {
	index: number;
	line: number;
	source: string;
	destination: string;
}

function collectRenameSites(
	source: string,
	lineOfIndex: (index: number) => number,
): RenameSite[] {
	const sites: RenameSite[] = [];
	for (const match of source.matchAll(RENAME_RE)) {
		const index = match.index as number;
		const args = splitCallArgs(source, index + match[0].length - 1);
		if (!args) continue;
		sites.push({
			index,
			line: lineOfIndex(index) - 1,
			source: normalizeExpr(args[0] ?? ''),
			destination: (args[1] ?? '').trim(),
		});
	}
	return sites;
}

/** One write call site with its destination target, precomputed per file. */
interface WriteTargetSite {
	index: number;
	target: string;
}

/**
 * Every recognized write, keyed on its DESTINATION expression. Used by
 * `isRenamedAwayNearby` to detect a second write landing on the same temp path
 * before the rename. Covering the whole head table (not just the direct-write
 * one) only ever CANCELS the temp-file exclusion, so widening it is the
 * conservative direction.
 */
function toWriteTargetSites(headSites: readonly HeadSite[]): WriteTargetSite[] {
	return headSites.map((site) => ({
		index: site.index,
		target: normalizeExpr(site.target),
	}));
}

function hasNearbyInvalidation(
	invalidations: readonly InvalidationSite[],
	lines: string[],
	writeLineIndex: number,
	targetVar: string,
): boolean {
	const end = Math.min(lines.length, writeLineIndex + 1 + FORWARD_WINDOW);
	const wanted = targetVar.trim();
	return invalidations.some(
		(site) =>
			site.line >= writeLineIndex && site.line < end && site.arg === wanted,
	);
}

/** Body text of `function <name>(` in `source`, up to the closing brace. */
function functionBody(source: string, name: string): string | null {
	const re = new RegExp(
		`(?:async\\s+)?function\\s+${name}\\s*(?:<[^(]*>)?\\s*\\(`,
	);
	const match = re.exec(source);
	if (!match) return null;
	const braceIndex = source.indexOf(
		'{',
		(match.index as number) + match[0].length,
	);
	if (braceIndex < 0) return null;
	const body = splitCallArgs(source, braceIndex);
	return body ? body.join(',') : null;
}

export interface Violation {
	file: string;
	line: number;
	rule: WriteRule | 'T' | 'H';
	targetVar: string;
	filename: string;
	detail: string;
}

function lineOf(source: string, index: number): number {
	return source.slice(0, index).split('\n').length;
}

/**
 * O(1) offset -> 1-based line lookup. `lineOf` slices and splits the prefix on
 * every call, which is O(n) per call and turned the whole-tree scan quadratic
 * once round 6 added per-site coverage checks.
 */
function makeLineIndex(source: string): (index: number) => number {
	const starts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === '\n') starts.push(i + 1);
	}
	return (index: number): number => {
		let lo = 0;
		let hi = starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((starts[mid] as number) <= index) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};
}

const INVALIDATE_CALL_RE = /(?<![A-Za-z0-9_$])invalidateCachedArtifact\s*\(/g;

/**
 * The artifact a write TARGET names, whether it is a bare identifier or an
 * inline path expression.
 *
 * The identifier branch is the pre-round-6 behaviour, unchanged. The inline
 * branch closes round 6's blocker 1: `writeFile(path.join(evidenceDir,
 * filename), data)` was skipped by construction, because every rule required
 * `/^[A-Za-z0-9_$]+$/`. An inline target has no variable to key an
 * `invalidateCachedArtifact(<var>)` check on, so it is reported unless the
 * SAME expression is passed to `invalidateCachedArtifact` in the forward
 * window — hoisting the path into a local is the intended fix, and it is what
 * makes the write visible to every other check in this file.
 */
interface WriteTarget {
	kind: 'var' | 'inline';
	filename: string;
	/** Resolved write path; only meaningful for `kind === 'inline'`. */
	writePath: string;
}

function classifyWriteTarget(
	target: string,
	callIndex: number,
	decls: Map<string, Declaration[]>,
	lines: string[],
	lineIdx: number,
	orderedCached: readonly string[],
	tables: FileTables,
): WriteTarget | null {
	if (/^[A-Za-z0-9_$]+$/.test(target)) {
		const filename = resolveCachedTarget(decls, lines, target, lineIdx);
		return filename ? { kind: 'var', filename, writePath: '' } : null;
	}
	const writePath = writePathOf(target, fileCtx(tables, callIndex));
	if (writePath === null) return null;
	for (const name of orderedCached) {
		if (cachedNameMatchesPath(name, writePath)) {
			return { kind: 'inline', filename: name, writePath };
		}
	}
	return null;
}

/** Whitespace-collapsed expression text, for identity comparison. */
function normalizeExpr(expr: string): string {
	return expr.trim().replace(/\s+/g, ' ');
}

/**
 * True when `invalidateCachedArtifact(<expr>)` appears in the forward window
 * with an argument that is the SAME EXPRESSION as the write target and folds to
 * the same path.
 *
 * Presence alone is NOT accepted — an unrelated invalidation on a neighbouring
 * line would make the rule fail open, which is the opposite of extending
 * coverage. Folded-path equality alone is not accepted either: two genuinely
 * different dynamic targets under one directory (`path.join(evidenceDir, a)`
 * and `path.join(evidenceDir, b)`) both fold to `evidence/*`, so pattern
 * equality would let an invalidation of one excuse a write of the other.
 * Requiring textual identity costs nothing real, because the intended fix for
 * an inline target is to hoist it into a local anyway.
 */
function hasMatchingInlineInvalidation(
	invalidations: readonly InvalidationSite[],
	lines: string[],
	writeLineIndex: number,
	writeTarget: string,
	writePath: string,
	tables: FileTables,
): boolean {
	const end = Math.min(lines.length, writeLineIndex + 1 + FORWARD_WINDOW);
	const wanted = normalizeExpr(writeTarget);
	return invalidations.some(
		(site) =>
			site.line >= writeLineIndex &&
			site.line < end &&
			site.arg === wanted &&
			writePathOf(site.arg, fileCtx(tables, site.index)) === writePath,
	);
}

/**
 * True when the written path is a TEMP FILE that is renamed onto the real
 * artifact inside the forward window. Nothing remains at the written path
 * afterwards, so `getStamp` returns null for it and a cache entry keyed on it is
 * unreachable. This is the same reasoning that makes RULE R check argument 2
 * only (see DELIBERATE EXCLUSIONS); without it, `evidence/**` would demand a
 * pointless `invalidateCachedArtifact(tempPath)` on every temp-then-rename
 * writer under `.swarm/evidence/`.
 *
 * "Temp file" is decided by DERIVATION, not proximity: the written path must
 * resolve to the rename DESTINATION's path plus a suffix. Proximity alone was
 * fail-open — `writeFile(evidencePath, …); if (x) rename(evidencePath, archive)`
 * and a catch-branch rename both leave the artifact at the written path on the
 * normal path, yet both mention the target as a rename source in the window.
 */
function isRenamedAwayNearby(
	renames: readonly RenameSite[],
	directWrites: readonly WriteTargetSite[],
	lines: string[],
	writeIndex: number,
	writeLineIndex: number,
	target: string,
	tables: FileTables,
): boolean {
	const end = Math.min(lines.length, writeLineIndex + 1 + FORWARD_WINDOW);
	const wanted = normalizeExpr(target);
	const writePath = writePathOf(target, fileCtx(tables, writeIndex));
	if (writePath === null) return false;
	let renameIndex = -1;
	for (const site of renames) {
		const index = site.index;
		if (index <= writeIndex) continue;
		if (site.line >= end) break;
		if (site.source !== wanted) continue;
		// DERIVATION, not proximity. The only safe shape is a TEMP file whose
		// path is the artifact's path plus a suffix (`${evidencePath}.tmp`): then
		// the written path provably differs from the artifact and holds nothing
		// after the rename. If the write target resolves to the SAME path as the
		// rename destination, the rename is a MOVE of a durable artifact and may
		// be conditional (`if (x) rename(p, archive)`) or in a catch — the
		// artifact can survive at the written path, so the write must still
		// invalidate.
		const destination = site.destination;
		if (!destination) continue;
		const destPath = writePathOf(destination, fileCtx(tables, index));
		if (destPath === null) continue;
		if (writePath === destPath || !writePath.startsWith(destPath)) continue;
		renameIndex = index;
		break;
	}
	if (renameIndex < 0) return false;
	// A SECOND write to the same target between this write and the rename means
	// the rename belongs to that later write, not to this one — this write's
	// content could still be sitting at the path. Matching is textual across a
	// line window, not a data-flow link, and src/tools/sast-baseline.ts has two
	// independent `writeFileSync(tempPath, …); renameSync(tempPath, baselinePath)`
	// blocks reusing the same variable names, so this is a real near-miss rather
	// than a hypothetical one.
	return !directWrites.some(
		(site) =>
			site.index > writeIndex &&
			site.index < renameIndex &&
			site.target === wanted,
	);
}

export function scanFile(
	relPath: string,
	rawSource: string,
	cachedFilenames: Set<string>,
): Violation[] {
	if (toPosixRel(relPath) === toPosixRel(CANONICAL_HELPER)) return [];
	const source = blankComments(rawSource);
	// Sound early-out: with no write, rename or transactFile call in the file,
	// no rule can fire, so the (comparatively expensive) pattern tables are never
	// built. This replaces the pre-round-6 `decls.size === 0` early-out, which
	// was NOT sound once inline targets became visible — an inline write needs no
	// resolved declaration at all.
	if (!ANY_WRITE_CALL_RE.test(source)) return [];
	const lines = source.split('\n');
	// Longest (most segments, then most characters) first so a violation report
	// names the most specific artifact that matches.
	const orderedCached = [...cachedFilenames].sort((a, b) => {
		const bySegments = b.split('/').length - a.split('/').length;
		return bySegments !== 0 ? bySegments : b.length - a.length;
	});
	const tables = buildFileTables(source);
	const decls = collectDeclarations(source, orderedCached, tables);
	const violations: Violation[] = [];
	// Precomputed once per file. Re-deriving these inside each coverage check
	// made the whole-tree scan quadratic.
	const lineIndex = makeLineIndex(source);
	const invalidations = collectInvalidationSites(source, lineIndex);
	const renames = collectRenameSites(source, lineIndex);
	const headSites = collectHeadSites(source);
	const writeTargets = toWriteTargetSites(headSites);

	const covered = (
		target: string,
		classified: WriteTarget,
		lineIdx: number,
	): boolean =>
		classified.kind === 'var'
			? hasNearbyInvalidation(invalidations, lines, lineIdx, target)
			: hasMatchingInlineInvalidation(
					invalidations,
					lines,
					lineIdx,
					target,
					classified.writePath,
					tables,
				);

	// RULES W / R / C / S — every head in WRITE_HEADS, keyed on the argument that
	// carries the destination path. One loop over one table, so a head cannot be
	// governed by the enumeration and by no rule (or vice versa).
	for (const hit of headSites) {
		const head = hit.head;
		const callIndex = hit.index;
		const target = hit.target;
		const lineIdx = lineIndex(callIndex) - 1;
		const classified = classifyWriteTarget(
			target,
			callIndex,
			decls,
			lines,
			lineIdx,
			orderedCached,
			tables,
		);
		if (!classified) continue;
		if (covered(target, classified, lineIdx)) continue;
		// The rename-away exclusion applies ONLY when the match came from a
		// directory-class `**` pattern. That confines this weakening to exactly
		// the over-approximation it offsets: a temp file that happens to live
		// under `.swarm/evidence/`. A write to a SPECIFICALLY named cached
		// artifact is still reported even if a rename mentions it nearby, because
		// there the rename could be conditional and the artifact could survive at
		// the written path. RULE R is excluded because its argument-2 semantics
		// already exclude the rename SOURCE — the only path a rename empties.
		if (
			head.rule !== 'R' &&
			classified.filename.endsWith(`/${RECURSIVE_WILDCARD}`) &&
			isRenamedAwayNearby(
				renames,
				writeTargets,
				lines,
				callIndex,
				lineIdx,
				target,
				tables,
			)
		) {
			continue;
		}
		const callText = hit.text.replace(/\s*\($/, '');
		violations.push({
			file: relPath,
			line: lineIdx + 1,
			rule: head.rule,
			targetVar: target,
			filename: classified.filename,
			detail:
				head.pathArgIndex === 0
					? `${callText}(${target}, …)`
					: `${callText}(…, ${target})`,
		});
	}

	// RULE H — call to a same-file helper that writes to one of its parameters.
	// The invalidation must live in the helper's body, keyed on that parameter.
	for (const helper of tables.writeHelpers.values()) {
		// Cheap early-out: a helper with no textual occurrence outside its own
		// body has no call site here, and scanning the whole file per helper is
		// what made this rule the dominant cost.
		if (
			source.indexOf(helper.name) >= helper.bodyIndex &&
			source.indexOf(helper.name, helper.bodyEnd) < 0
		) {
			continue;
		}
		const callRe = new RegExp(
			`(?<![A-Za-z0-9_$.])${helper.name}\\s*(?:<[^(]*>)?\\s*\\(`,
			'g',
		);
		// The invalidation must be keyed on the written parameter AND appear after
		// the write in the body — an invalidation placed before the write, or on
		// some other value, does not make the artifact fresh.
		const invalidateAt = helper.body.search(
			new RegExp(
				`(?<![A-Za-z0-9_$])invalidateCachedArtifact\\s*\\(\\s*${helper.paramName}\\s*[,)]`,
			),
		);
		const invalidates = invalidateAt > helper.writeIndex;
		for (const match of source.matchAll(callRe)) {
			const callIndex = match.index as number;
			// The declaration itself, and any recursive call inside the body, are
			// not call sites that hand in a new target.
			if (callIndex >= helper.bodyIndex && callIndex <= helper.bodyEnd)
				continue;
			if (
				/\bfunction\s+$/.test(
					source.slice(Math.max(0, callIndex - 32), callIndex),
				)
			) {
				continue;
			}
			const args = splitCallArgs(source, callIndex + match[0].length - 1);
			const target = args?.[helper.paramIndex]?.trim();
			if (!target) continue;
			const lineIdx = lineIndex(callIndex) - 1;
			const classified = classifyWriteTarget(
				target,
				callIndex,
				decls,
				lines,
				lineIdx,
				orderedCached,
				tables,
			);
			if (!classified) continue;
			if (invalidates) continue;
			if (covered(target, classified, lineIdx)) continue;
			violations.push({
				file: relPath,
				line: lineIdx + 1,
				rule: 'H',
				targetVar: target,
				filename: classified.filename,
				detail: `${helper.name}(${target}, …) — helper writes to its '${helper.paramName}' parameter but never invalidates it`,
			});
		}
	}

	// RULE T — transactFile's write callback owns the invalidation.
	for (const match of source.matchAll(TRANSACT_RE)) {
		const callIndex = match.index as number;
		const openIndex = callIndex + match[0].length - 1;
		const args = splitCallArgs(source, openIndex);
		const target = args?.[0]?.trim();
		const writer = args?.[2]?.trim();
		if (!target) continue;
		const lineIdx = lineIndex(callIndex) - 1;
		const classified = classifyWriteTarget(
			target,
			callIndex,
			decls,
			lines,
			lineIdx,
			orderedCached,
			tables,
		);
		if (!classified) continue;
		if (!writer) continue;
		const writerName = writer.replace(/^.*\./, '');
		if (!/^[A-Za-z0-9_$]+$/.test(writerName)) continue;
		const body = functionBody(source, writerName);
		if (body?.includes('invalidateCachedArtifact(')) continue;
		violations.push({
			file: relPath,
			line: lineIdx + 1,
			rule: 'T',
			targetVar: target,
			filename: classified.filename,
			detail: `transactFile(${target}, …, ${writer}, …) — write callback '${writerName}' never invalidates`,
		});
	}

	return violations;
}

// ---------------------------------------------------------------------------
// Read-side harvest and the unresolved-reader registry
// ---------------------------------------------------------------------------

/** A cached-reader call site whose path argument could not be folded. */
export interface UnresolvedReaderSite {
	/** Repo-relative, forward slashes. */
	file: string;
	/** Bare callee name (member prefixes stripped). */
	callee: string;
	/** The exact path argument text, whitespace-collapsed. */
	arg: string;
	line: number;
}

export type UnresolvedReaderCategory =
	| 'wrapper-internal'
	| 'declared-patterns'
	| 'no-additional-artifact';

export interface UnresolvedReaderRegistration {
	file: string;
	callee: string;
	arg: string;
	category: UnresolvedReaderCategory;
	/**
	 * Artifact patterns this site reads, added to the cached set. `${IDENT}` is
	 * resolved against `file`'s own source, so renaming the underlying constant
	 * fails the gate instead of silently killing the rule.
	 */
	patterns: readonly string[];
	reason: string;
}

/**
 * Every cached-reader call site whose path argument is not statically
 * resolvable. This list is asserted to equal the discovered set EXACTLY, in
 * both directions, by
 * tests/unit/build/swarm-write-cache-invalidation-scan.test.ts — a new
 * unresolvable reader fails the gate instead of quietly disappearing from the
 * scan's blast radius.
 */
export const UNRESOLVED_READER_REGISTRY: readonly UnresolvedReaderRegistration[] =
	[
		// (#2480) src/hooks/curator-drift.ts was removed from this registry:
		// readPriorDriftReports now reads the swarm.db phase_report table (no
		// filesystem reader, no cached artifact, no #1729 stale-read hazard).
		{
			file: 'src/summaries/manager.ts',
			callee: 'readSwarmFileAsync',
			arg: 'relativePath',
			category: 'declared-patterns',
			patterns: ['summaries/*.json'],
			reason:
				'`relativePath` is path.join("summaries", filename) over an UNCAPPED ' +
				'readdir listing (issue #2483 lenient retention enumeration — any ' +
				'S*.json occupant is a candidate), so the argument folds to no ' +
				'literal. The reader`s real blast radius is exactly summaries/*.json: ' +
				'listStaleSummaryIds reads candidate summaries content-timestamp-first ' +
				'purely to decide staleness before rmSync. A stale cached read can ' +
				'only postpone one entry`s deletion to the next sweep (fail-open, ' +
				'bounded by the retention horizon), never resurrect deleted content.',
		},
		{
			file: 'src/hooks/knowledge-curator.ts',
			callee: 'readSwarmFileAsync',
			arg: 'relativeEvidencePath',
			category: 'declared-patterns',
			patterns: ['evidence/**'],
			reason:
				'The path is derived from an observed trigger file path by stripping ' +
				'everything up to and including `.swarm/`, so it folds to no literal. ' +
				'The trigger filter is isEvidencePath() — /(?:^|\\/)\\.swarm\\/+evidence\\//i ' +
				'— which is UNRESTRICTED below .swarm/evidence/, at any depth. Round 6 ' +
				'of #1619 found this entry previously declared `evidence/*.json` plus ' +
				'`evidence.json` and claimed those were the only two layouts; that was ' +
				'false — `evidence/<phase>/phase-council.json`, ' +
				'`evidence/<phase>/drift-verifier.json`, ' +
				'`evidence/<phase>/lean-turbo/*.json` and ' +
				'`evidence/<taskId>/reviewer.json` all sit two levels down and matched ' +
				'neither. The declared pattern is therefore the reader`s real blast ' +
				'radius, `evidence/**`, which closes the whole directory as a CLASS ' +
				'instead of enumerating layouts a future one can escape.',
		},
		{
			file: 'src/hooks/utils.ts',
			callee: 'readSwarmFileAsync',
			arg: 'filename',
			category: 'wrapper-internal',
			patterns: [],
			reason:
				'Self-recursive memoization hop inside readSwarmFileAsync itself. The ' +
				'artifact names flow in from the wrapper CALL SITES, which are exactly ' +
				'what this harvester reads, so nothing is hidden here.',
		},
		{
			file: 'src/hooks/utils.ts',
			callee: 'readCachedTextFile',
			arg: 'resolvedPath',
			category: 'wrapper-internal',
			patterns: [],
			reason:
				'The cache read inside readSwarmFileAsync itself; `resolvedPath` is ' +
				'validateSwarmPath(directory, filename) over the wrapper parameter. ' +
				'Same argument as the entry above.',
		},
		{
			file: 'src/hooks/knowledge-store.ts',
			callee: 'readCachedParsedFile',
			arg: 'resolvedPath',
			category: 'no-additional-artifact',
			patterns: [],
			reason:
				'`resolvedPath` is path.resolve() over a function parameter. It always ' +
				'names a knowledge*.jsonl file in the (possibly linked) knowledge store, ' +
				'never a .swarm artifact this scan governs, and every writer of those ' +
				'files routes through transactKnowledge -> atomicWriteFile, which ' +
				'invalidates internally.',
		},
		{
			file: 'src/services/context-budget-service.ts',
			callee: 'readCachedTextFile',
			arg: 'filePath',
			category: 'no-additional-artifact',
			patterns: [],
			reason:
				'readFileOrEmpty()`s parameter. Its callers pass already-resolved ' +
				'knowledge-store paths (resolveSwarmKnowledgePath), which are written ' +
				'exclusively through atomicWriteFile; the .swarm artifacts this service ' +
				'reads go through readSwarmFileAsync and are harvested from those calls.',
		},
	];

export function registryKey(entry: {
	file: string;
	callee: string;
	arg: string;
}): string {
	return `${entry.file}|${entry.callee}|${entry.arg}`;
}

/**
 * Resolve a registration's declared patterns against its own file, folding
 * `${IDENT}` through that file's constant table. Throws when a pattern
 * references a constant the file no longer defines — that is the cross-check
 * that keeps a hand-declared pattern from silently going dead after a rename.
 */
export function resolveRegistryPatterns(
	entry: UnresolvedReaderRegistration,
): string[] {
	if (entry.patterns.length === 0) return [];
	const source = blankComments(
		readFileSync(join(REPO_ROOT, entry.file), 'utf-8'),
	);
	const ctx = fileCtx(buildFileTables(source), source.length);
	return entry.patterns.map((pattern) => {
		const resolved = pattern.replace(
			/\$\{([^{}]*)\}/g,
			(_full, rawExpr: string) => {
				const ident = rawExpr.trim();
				const value = lookupVarPattern(ctx, ident);
				if (value === null) {
					throw new Error(
						`UNRESOLVED_READER_REGISTRY entry ${registryKey(entry)} declares ` +
							`pattern '${pattern}', but '${ident}' is not a resolvable string ` +
							`constant in ${entry.file}. Update the declared pattern.`,
					);
				}
				return value;
			},
		);
		const segs = resolved.split('/').filter((seg) => seg.length > 0);
		const recursiveAt = segs.indexOf(RECURSIVE_WILDCARD);
		if (recursiveAt >= 0) {
			if (recursiveAt !== segs.length - 1 || recursiveAt === 0) {
				throw new Error(
					`UNRESOLVED_READER_REGISTRY entry ${registryKey(entry)} declares ` +
						`pattern '${pattern}': '${RECURSIVE_WILDCARD}' is only supported as ` +
						'the LAST segment of a pattern that has at least one segment ' +
						'before it (e.g. `evidence/**`).',
				);
			}
			if (segs.slice(0, -1).some((seg) => seg.includes(WILDCARD))) {
				throw new Error(
					`UNRESOLVED_READER_REGISTRY entry ${registryKey(entry)} declares ` +
						`pattern '${pattern}': every segment before '${RECURSIVE_WILDCARD}' ` +
						'must be fully literal, otherwise the pattern matches an ' +
						'unbounded set of directories.',
				);
			}
		}
		if (!isSpecificName(resolved)) {
			throw new Error(
				`UNRESOLVED_READER_REGISTRY entry ${registryKey(entry)} declares ` +
					`pattern '${pattern}', which resolves to the non-specific name ` +
					`'${resolved}'. A pattern that loose would flood the scan.`,
			);
		}
		return resolved;
	});
}

/** Exported `read*` functions of the cache module — the authoritative list. */
export function collectExportedCacheReaders(): Set<string> {
	const source = blankComments(
		readFileSync(join(REPO_ROOT, CACHE_MODULE_REL), 'utf-8'),
	);
	const names = new Set<string>();
	for (const match of source.matchAll(
		/export\s+(?:async\s+)?function\s+(read[A-Za-z0-9_$]*)/g,
	)) {
		names.add(match[1] as string);
	}
	return names;
}

export interface CachedArtifactHarvest {
	/** Artifact names/patterns discovered from resolvable reader call sites. */
	names: Set<string>;
	/** Reader call sites whose path argument could not be folded. */
	unresolved: UnresolvedReaderSite[];
	/** Total cached-reader call sites seen (definitions excluded). */
	totalCallSites: number;
	/** Call sites whose path argument folded to a specific artifact name. */
	resolvedCallSites: number;
}

/**
 * Bucket every cached-reader call site in ONE source file as resolved or
 * unresolved. Exported so the shape fixtures in
 * tests/unit/build/swarm-write-cache-invalidation-shapes.test.ts can pin the
 * harvest of a specific call shape without depending on src/ still containing
 * an example of it.
 */
export function harvestCachedArtifactsFromSource(
	relPath: string,
	rawSource: string,
): CachedArtifactHarvest {
	const names = new Set<string>();
	const unresolved: UnresolvedReaderSite[] = [];
	let totalCallSites = 0;
	let resolvedCallSites = 0;
	const content = blankComments(rawSource);
	if (!CACHED_READER_SIGNATURES.some((sig) => content.includes(sig.name))) {
		return { names, unresolved, totalCallSites, resolvedCallSites };
	}
	const tables = buildFileTables(content);
	const file = toPosixRel(relPath);
	for (const match of content.matchAll(CACHED_READER_CALL_RE)) {
		const index = match.index as number;
		// A declaration (`export async function readCachedTextFile(`) is not a
		// call site; skipping it keeps the reader's own signature out of the
		// registry.
		if (/\bfunction\s+$/.test(content.slice(Math.max(0, index - 32), index))) {
			continue;
		}
		const callee = match[1] as string;
		const signature = READER_BY_NAME.get(callee);
		if (!signature) continue;
		totalCallSites++;
		const line = lineOf(content, index);
		const openIndex = index + (match[0] as string).length - 1;
		const args = splitCallArgs(content, openIndex);
		const rawArg = args?.[signature.pathArgIndex]?.trim();
		if (!rawArg) {
			unresolved.push({
				file,
				callee,
				arg: args ? '<missing argument>' : '<unparsed call>',
				line,
			});
			continue;
		}
		const arg = rawArg.replace(/\s+/g, ' ');
		const pattern = resolvePattern(rawArg, fileCtx(tables, index));
		const name = pattern === null ? null : harvestName(toUnits(pattern));
		if (name !== null && isSpecificName(name)) {
			names.add(name);
			resolvedCallSites++;
			continue;
		}
		unresolved.push({ file, callee, arg, line });
	}
	return { names, unresolved, totalCallSites, resolvedCallSites };
}

/**
 * Walk src/ and bucket EVERY cached-reader call site as resolved or
 * unresolved. `totalCallSites === resolvedCallSites + unresolved.length` is
 * asserted by the scan test: without that identity a call whose argument list
 * fails to parse would fall into neither bucket and be invisible again.
 */
export function harvestCachedArtifacts(): CachedArtifactHarvest {
	const names = new Set<string>();
	const unresolved: UnresolvedReaderSite[] = [];
	let totalCallSites = 0;
	let resolvedCallSites = 0;
	for (const relPath of listSourceFiles()) {
		const fileHarvest = harvestCachedArtifactsFromSource(
			relPath,
			readFileSync(join(REPO_ROOT, relPath), 'utf-8'),
		);
		for (const name of fileHarvest.names) names.add(name);
		unresolved.push(...fileHarvest.unresolved);
		totalCallSites += fileHarvest.totalCallSites;
		resolvedCallSites += fileHarvest.resolvedCallSites;
	}
	return { names, unresolved, totalCallSites, resolvedCallSites };
}

/**
 * The authoritative cached-artifact set: every name folded from a reader call
 * site, plus every pattern declared for a registered unresolvable reader.
 */
export function collectCachedArtifactFilenames(): Set<string> {
	const harvest = harvestCachedArtifacts();
	const names = new Set(harvest.names);
	for (const entry of UNRESOLVED_READER_REGISTRY) {
		for (const pattern of resolveRegistryPatterns(entry)) names.add(pattern);
	}
	return names;
}

export function scanTree(cachedFilenames: Set<string>): Violation[] {
	return listSourceFiles().flatMap((rel) =>
		scanFile(rel, readFileSync(join(REPO_ROOT, rel), 'utf-8'), cachedFilenames),
	);
}

// ---------------------------------------------------------------------------
// Write-side enumeration (issue #1619 round 6)
// ---------------------------------------------------------------------------

/**
 * A single write call site and what its target expression folded to. This is
 * the write-side mirror of `harvestCachedArtifacts`: rounds 2-6 each found one
 * more writer the rules could not SEE, so the fix is the same one that fixed
 * the read side — bucket every site and make the unresolvable ones countable
 * instead of invisible.
 */
export interface WriteSiteRecord {
	file: string;
	line: number;
	rule: WriteRule;
	/** The target expression text, whitespace-collapsed. */
	target: string;
	/** Folded write path, or null when the expression is not representable. */
	writePath: string | null;
}

/**
 * An IDENTIFIER carrying `evidence` in any casing — `EVIDENCE_DIR`,
 * `resolveEvidencePath`, `evidenceDir`, `phaseEvidencePath`. Round 7 added this
 * branch: through round 6 the filter required a QUOTED LITERAL containing
 * `evidence`, so a module that imported an evidence-path constant or helper
 * FROM ANOTHER MODULE was dropped from `collectEvidenceBlindSpots` entirely —
 * and, because resolution is single-file, its target folded to null anyway, so
 * the site was invisible to the rules AND to the enumeration at once. That is
 * the same double blindness `WRITE_HEADS` closes on the head axis.
 *
 * Measured 2026-08-11: this branch takes the candidate set from 124 files to
 * 237 and adds 8 unfoldable sites across 6 files, every one of them registered
 * below with a verified destination.
 */
const EVIDENCE_IDENTIFIER_RE = /(?<![A-Za-z0-9_$])[A-Za-z0-9_$]*evidence/i;

/**
 * True when a file could construct a path below `.swarm/evidence/`. Purely
 * lexical and deliberately generous — it is the CANDIDATE filter for
 * `collectEvidenceBlindSpots`, so over-inclusion costs only registry entries
 * while under-inclusion recreates the blindness this whole scan exists to
 * prevent. Comments are blanked first, so prose about evidence does not make a
 * file a candidate.
 */
export function mentionsEvidencePath(source: string): boolean {
	const content = blankComments(source);
	return (
		/['"`]evidence[/'"`]/.test(content) ||
		/['"`][^'"`]*\/evidence(?:[/'"`])/.test(content) ||
		EVIDENCE_IDENTIFIER_RE.test(content)
	);
}

/**
 * `[start, end)` spans of every template literal in `source`. Template bodies
 * are preserved by `blankComments` (the scan needs the filename literals inside
 * them), which means a prompt string that QUOTES example code — e.g. the
 * `handle.writeFile(...)` samples in src/hooks/pr-workflow-gate.ts — otherwise
 * shows up as a write site. Those are documentation, not writers.
 */
function templateSpans(source: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (let i = 0; i < source.length; i++) {
		if (source[i] !== '`') continue;
		const start = i;
		for (i++; i < source.length; i++) {
			if (source[i] === '\\') {
				i++;
				continue;
			}
			if (source[i] === '`') break;
		}
		spans.push([start, Math.min(i, source.length)]);
	}
	return spans;
}

/**
 * A member/element ACCESS chain: `this.evidencePath`, `_internals.planPath`,
 * `paths[i]`, `entries[0].dest`. Round 7 added the bracket branch — the
 * dot-only pattern rejected `writeFile(paths[i], data)`, so that shape hit the
 * `continue` below and was invisible to the rules AND to the enumeration at the
 * same time, which is the same-root-cause escape as an unrecognised head.
 */
const ACCESS_CHAIN_RE = /^[A-Za-z0-9_$]+(?:\.[A-Za-z0-9_$]+|\[[^[\]]*\])*$/;

/**
 * A target expression that could name a path (vs. a payload argument such as
 * `JSON.stringify(lock)` in a `handle.writeFile(data)` FileHandle call). Access
 * chains count: they name a path even though the engine cannot fold them.
 */
function looksLikePathExpression(target: string): boolean {
	return (
		ACCESS_CHAIN_RE.test(target) ||
		PATH_PRODUCER_RE.test(target) ||
		LOCAL_CALL_RE.test(target) ||
		target.startsWith('`') ||
		target.startsWith("'") ||
		target.startsWith('"')
	);
}

export function collectWriteSitesFromSource(
	relPath: string,
	rawSource: string,
): WriteSiteRecord[] {
	const source = blankComments(rawSource);
	const tables = buildFileTables(source);
	const spans = templateSpans(source);
	// A site inside a helper that RULE H already governs is covered at every
	// CALL site of that helper, so it is not a blind spot.
	const helperSpans = [...tables.writeHelpers.values()].map(
		(helper) => [helper.bodyIndex, helper.bodyEnd] as const,
	);
	const sites: WriteSiteRecord[] = [];
	for (const hit of collectHeadSites(source)) {
		const callIndex = hit.index;
		if (spans.some(([a, b]) => callIndex > a && callIndex < b)) continue;
		if (helperSpans.some(([a, b]) => callIndex > a && callIndex < b)) continue;
		if (!looksLikePathExpression(hit.target)) continue;
		sites.push({
			file: toPosixRel(relPath),
			line: lineOf(source, callIndex),
			rule: hit.head.rule,
			target: hit.target.replace(/\s+/g, ' '),
			writePath: writePathOf(hit.target, fileCtx(tables, callIndex)),
		});
	}
	return sites;
}

/**
 * Every write call site in a file that constructs a `.swarm/evidence/` path
 * whose target expression the pattern engine folds to NOTHING. Each one is a
 * place where a new evidence artifact could be written without any rule seeing
 * it, and `tests/unit/build/swarm-write-cache-evidence-class.test.ts` pins the
 * set against `EVIDENCE_WRITE_BLIND_SPOTS` so a NEW one fails the gate.
 *
 * SCOPE — this is not the guard's whole blind spot. The filter below is
 * `writePath === null`, so a target that folds PARTIALLY — to a pattern that is
 * real but matches no cached artifact name, e.g. `path.join(dir, '.swarm', sub,
 * `${id}.json`)` folding to `*.json` when `sub` is a parameter — is collected by
 * neither axis: no rule fires (nothing matches) and no registry entry is
 * demanded (the fold is non-null). Two live sites are in that state today, both
 * benign temp files (src/test-impact/history-store.ts:226 and :354, folding to
 * `*.tmp`). Widening this filter to "null OR matches no cached name" is the next
 * ratchet; it would require registering those two first.
 */
export function collectEvidenceBlindSpots(): WriteSiteRecord[] {
	const out: WriteSiteRecord[] = [];
	for (const relPath of listSourceFiles()) {
		if (toPosixRel(relPath) === toPosixRel(CANONICAL_HELPER)) continue;
		const raw = readFileSync(join(REPO_ROOT, relPath), 'utf-8');
		if (!mentionsEvidencePath(raw)) continue;
		for (const site of collectWriteSitesFromSource(relPath, raw)) {
			if (site.writePath === null) out.push(site);
		}
	}
	return out;
}

/**
 * Stable key for a blind spot. Deliberately excludes the line number: an edit
 * ten lines above a site must not invalidate its registration, or the registry
 * becomes churn that gets rubber-stamped — which is the failure mode this whole
 * mechanism exists to prevent.
 */
export function blindSpotKey(site: {
	file: string;
	rule: WriteRule;
	target: string;
}): string {
	return `${site.file}|${site.rule}|${site.target}`;
}

export type BlindSpotStatus =
	/** The folded-away path is not a `.swarm/evidence/` artifact at all. */
	| 'not-an-evidence-artifact'
	/**
	 * It IS an evidence artifact, the expression is not foldable, and the writer
	 * therefore invalidates by hand. The test cross-checks the source for
	 * `invalidateCachedArtifact(<target>)`, so deleting the call fails the gate.
	 */
	| 'invalidates-explicitly';

export interface EvidenceWriteBlindSpot {
	file: string;
	rule: WriteRule;
	target: string;
	status: BlindSpotStatus;
	reason: string;
}

/**
 * The write-side mirror of `UNRESOLVED_READER_REGISTRY`, added in #1619 round 6.
 *
 * Rounds 2-6 each found exactly one more `.swarm/evidence/` writer the rules
 * could not SEE. The read side already solved that class of failure by refusing
 * to drop an unresolvable call site silently; this does the same for writes.
 * Every write call site in a file that constructs a `.swarm/evidence/` path and
 * whose target expression the pattern engine cannot fold must appear here with
 * a stated status, and
 * tests/unit/build/swarm-write-cache-evidence-class.test.ts asserts set
 * equality in BOTH directions.
 *
 * SCOPE of the guarantee — stated as what the code actually enforces, because
 * the pre-round-7 wording ("a new unfoldable writer under `.swarm/evidence/` can
 * no longer arrive unnoticed") was an absolute, and round 7 falsified it by
 * injecting five writers that arrived entirely unnoticed. A write call site
 * reaches one of two loud outcomes ONLY IF four things hold:
 *
 *   1. its call head is in `WRITE_HEADS` — closed against the `node:fs` mutating
 *      surface `src/` calls, machine-checked in
 *      tests/unit/build/swarm-write-cache-write-heads.test.ts, but NOT closed
 *      against a shelled-out `cp`, `Bun.file(p).writer()`, or a cross-module
 *      write helper (see the WRITE HEADS entry in KNOWN LIMITATIONS);
 *   2. its file is selected by `mentionsEvidencePath` — a quoted `evidence` path
 *      segment, an import specifier containing one, or an identifier carrying
 *      `evidence`; a constant that names the directory without the word escapes;
 *   3. its target is a path-shaped expression (`looksLikePathExpression`) rather
 *      than, say, a computed call result;
 *   4. its target either folds to NOTHING — in which case it is enumerated and
 *      must be registered — or folds to a pattern some cached artifact name
 *      matches. A target that folds PARTIALLY, to a real pattern that matches no
 *      cached name (`path.join(dir, '.swarm', sub, `${id}.json`)` -> `*.json`
 *      when `sub` is a parameter), satisfies conditions 1-3 and is silent on
 *      both axes. Verified by injection in round 8; see the SCOPE note on
 *      `collectEvidenceBlindSpots`.
 *
 * When all four hold the site either RESOLVES — and RULES R/W/C/S/T/H govern it
 * against the `evidence/**` pattern — or it fails this gate until registered.
 */
/**
 * Verify an `invalidates-explicitly` registration against live source. Returns
 * null when the file really does invalidate `target` AFTER writing to it, or a
 * failure reason.
 *
 * This is the ONLY protection for a site no static rule can see, so it must not
 * be a raw substring search: round 6's own review showed that
 * `source.includes('invalidateCachedArtifact(safeTarget)')` on UNBLANKED source
 * is satisfied by `// invalidateCachedArtifact(safeTarget);`, which would let
 * the exact stale-read hazard back in with the whole gate green. Comments are
 * blanked and the call must follow the write.
 */
export function checkExplicitInvalidation(
	relFile: string,
	target: string,
): string | null {
	const source = blankComments(readFileSync(join(REPO_ROOT, relFile), 'utf-8'));
	const wanted = normalizeExpr(target);
	let writeIndex = -1;
	// Derived from WRITE_HEADS: a registration whose write is a copy/stream/open
	// head would otherwise report "no write found" and force the entry out, which
	// is a fail-open for the one class of site no static rule can see.
	for (const hit of collectHeadSites(source)) {
		if (normalizeExpr(hit.target) !== wanted) continue;
		if (writeIndex < 0 || hit.index < writeIndex) writeIndex = hit.index;
	}
	if (writeIndex < 0) {
		return `no write to '${target}' found in ${relFile} — the registration no longer describes this file`;
	}
	for (const match of source.matchAll(INVALIDATE_CALL_RE)) {
		const index = match.index as number;
		if (index < writeIndex) continue;
		const arg = splitCallArgs(source, index + match[0].length - 1)?.[0];
		if (arg && normalizeExpr(arg) === wanted) return null;
	}
	return `${relFile} writes '${target}' but has no invalidateCachedArtifact(${target}) call after the write (comments do not count)`;
}

export const EVIDENCE_WRITE_BLIND_SPOTS: readonly EvidenceWriteBlindSpot[] = [
	{
		file: 'src/services/cost-accounting.ts',
		rule: 'C',
		target: 'snap',
		status: 'not-an-evidence-artifact',
		reason:
			'readTelemetryEvents() copies telemetry.jsonl snapshots into an OS ' +
			'temporary directory created with os.tmpdir(); the `snap` target is ' +
			'always outside the project .swarm/evidence/ tree. The scanner sees the ' +
			'copyFileSync call in a file that also reads evidence-adjacent telemetry, ' +
			'but this snapshot is transient input staging, not a cached evidence write.',
	},
	{
		file: 'src/utils/atomic-write.ts',
		rule: 'R',
		target: 'to',
		status: 'not-an-evidence-artifact',
		reason:
			'Issue #2035: renameWithRetry(tempPath, resolvedTarget) inside the ' +
			'canonical atomic-write core is parameter-passed BY CONTRACT (every ' +
			'.swarm writer delegates here with its own already-validated target — ' +
			'the former task-file.ts CANONICAL_HELPER exemption moved its body ' +
			'here). The core unconditionally calls ' +
			'invalidateCachedArtifact(resolvedTarget) after the successful rename ' +
			'(same function, machine-checkable by RULE-checker), so the cache ' +
			'invalidation requirement the scan enforces is met at the single ' +
			'point every migrated writer funnels through.',
	},
	{
		file: 'src/background/pending-delegations.ts',
		rule: 'R',
		target: 'to',
		status: 'not-an-evidence-artifact',
		reason:
			'renameOnce(from, to) sits on the _checkpointInternals OBJECT ' +
			'LITERAL, so RULE H cannot move the requirement into the callee. ' +
			'Every production caller reaches it through writeDurableFileSync ' +
			'with a target from storePath() / checkpointPath() / manifestPath() ' +
			'-> .swarm/background-delegations{,.checkpoint.json,.manifest.json}, ' +
			'none of which are cached evidence artifacts. The temp-file writes ' +
			'beside each rename go through fsynced descriptors opened at a named ' +
			'tmp const in the same function (issue #2034).',
	},
	{
		file: 'src/background/pending-delegations.ts',
		rule: 'W',
		target: 'absPath',
		status: 'not-an-evidence-artifact',
		reason:
			'fallbackPath() -> validateSwarmPath(directory, fallbackRelativePath(id)) ' +
			'-> .swarm/background-delegation-fallback/<digest>.json. The file is a ' +
			'candidate only because it imports ../evidence/lock.js, which the ' +
			'deliberately generous mentionsEvidencePath() filter also matches.',
	},
	{
		file: 'src/test-impact/history-store.ts',
		rule: 'R',
		target: 'historyPath',
		status: 'not-an-evidence-artifact',
		reason:
			'getHistoryPath() returns .swarm/cache/test-history.jsonl. It is a ' +
			'multi-statement function (it validates workingDir first), so it is not a ' +
			'single-return path producer and folds to null. No cached reader consumes ' +
			'that file; the candidate filter matched only the ../evidence/manager.js ' +
			'import.',
	},
	{
		file: 'src/review/evidence.ts',
		rule: 'R',
		target: 'safeTarget',
		status: 'invalidates-explicitly',
		reason:
			'persistAutoReviewEvidence() commits .swarm/evidence/<phase>/auto-review.json. ' +
			'`safeTarget` is validateSwarmPath(directory, path.relative(...)), and ' +
			'path.relative is not a path PRODUCER this engine models, so the target ' +
			'folds to null however good the resolver gets. Round 6 found this writer ' +
			'unguarded; it now invalidates by hand right after the rename.',
	},
	{
		file: 'src/tools/sbom-generate.ts',
		rule: 'W',
		target: 'outputPath',
		status: 'invalidates-explicitly',
		reason:
			'Writes under .swarm/evidence/sbom/ (DEFAULT_OUTPUT_DIR). `outputDir` is ' +
			'a tool ARGUMENT with a default applied at runtime, so no static fold can ' +
			'reach the literal. Round 6 found this writer unguarded; it now ' +
			'invalidates by hand after the write.',
	},
	// --- Round 7: surfaced by the COPY class in WRITE_HEADS -------------------
	{
		file: 'src/commands/close.ts',
		rule: 'C',
		target: 'destEntry',
		status: 'not-an-evidence-artifact',
		reason:
			'copyDirRecursiveWithFailures(src, dest) copies each entry to ' +
			'path.join(dest, entry); `dest` is a PARAMETER so the target folds to ' +
			'null. Its only caller (runArchiveStage) passes ' +
			'path.join(ctx.archiveDir, dirName), and ctx.archiveDir is ' +
			'.swarm/archive/swarm-<timestamp>-<suffix>. The destination is therefore ' +
			'always under .swarm/archive/, never .swarm/evidence/ — evidence/ is one ' +
			'of the SOURCE directories it archives, which is why the file is a ' +
			'candidate at all.',
	},
	{
		file: 'src/commands/close.ts',
		rule: 'C',
		target: 'destPath',
		status: 'not-an-evidence-artifact',
		reason:
			'Two archive copies (the fixed artifact list and the dynamic ' +
			'post-mortem/drift-report list) share this target: ' +
			'path.join(ctx.archiveDir, artifact). `ctx.archiveDir` is a member ' +
			'expression the engine cannot fold, and it resolves to ' +
			'.swarm/archive/swarm-<timestamp>-<suffix> — outside .swarm/evidence/.',
	},
	{
		file: 'src/evaluation/gate-audit.ts',
		rule: 'C',
		target: 'tempRoot',
		status: 'not-an-evidence-artifact',
		reason:
			'Both cpSync sites copy an evaluation environment into ' +
			'fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), …))) — an OS ' +
			'temp directory outside the project tree entirely, so it can never be a ' +
			'.swarm/ artifact. The file is a candidate because it also writes real ' +
			'audit output under .swarm/evidence/gate-audit/ through swarmPath().',
	},
	// --- Round 7: surfaced by the STREAM/HANDLE class in WRITE_HEADS ----------
	{
		file: 'src/evidence/documents-retention.ts',
		rule: 'S',
		target: 'p',
		status: 'not-an-evidence-artifact',
		reason:
			'`openSync: (p, flags) => fs.openSync(p, flags)` is a test-seam shim in ' +
			'the module `_internals` OBJECT LITERAL. Object-literal methods are not ' +
			'parsed by collectFunctions (a stated limitation), so `p` folds to null. ' +
			'The shim names no artifact of its own; its one caller opens ' +
			'`${filePath}.tmp.<time>.<pid>` and renames it onto that filePath.',
	},
	{
		file: 'src/evidence/task-gate-repair.ts',
		rule: 'W',
		target: 'serialized',
		status: 'not-an-evidence-artifact',
		reason:
			'`fileHandle.writeFile(serialized)` writes bytes to the FileHandle that ' +
			'was opened on the quarantined temporary path; `serialized` is payload, ' +
			'not a pathname. The temp path is invalidated before the link and the ' +
			'published quarantine target is invalidated immediately after the link.',
	},
	// --- Round 7: surfaced by the widened mentionsEvidencePath candidate filter
	{
		file: 'src/background/evidence-summary-integration.ts',
		rule: 'W',
		target: 'artifactPath',
		status: 'not-an-evidence-artifact',
		reason:
			'path.join(swarmPath, filename) where `filename` is a function ' +
			'PARAMETER. Its only caller passes ' +
			"`this.config.summaryFilename ?? 'evidence-summary.json'`, so the target " +
			'is the one-level file .swarm/evidence-summary.json — a sibling of the ' +
			'evidence/ DIRECTORY, not a member of it. No cached reader consumes it.',
	},
	{
		file: 'src/background/status-artifact.ts',
		rule: 'W',
		target: 'filePath',
		status: 'not-an-evidence-artifact',
		reason:
			'`this.getFilePath()` returns path.join(this.swarmDir, this.filename); ' +
			'`this` member expressions are unfoldable. The artifact is the ' +
			'automation status snapshot written directly in .swarm/, not under ' +
			'evidence/, and no cached reader consumes it.',
	},
	{
		file: 'src/hooks/review-receipt.ts',
		rule: 'R',
		target: 'receiptPath',
		status: 'not-an-evidence-artifact',
		reason:
			'renameSync(tmpPath, receiptPath) where receiptPath is ' +
			'path.join(context.receipts.path, filename) — a member expression the ' +
			'engine cannot fold. resolveReceiptsDir() shows the directory is ' +
			'.swarm/review-receipts/, outside .swarm/evidence/, and no cached reader ' +
			'consumes it.',
	},
	{
		file: 'src/hooks/review-receipt.ts',
		rule: 'R',
		target: 'resolvedPath',
		status: 'not-an-evidence-artifact',
		reason:
			'The validation-commit twin of the entry above: ' +
			'path.resolve(receiptPath) over the same .swarm/review-receipts/ path. ' +
			'path.resolve of an unfoldable operand stays unfoldable.',
	},
	{
		file: 'src/plan/manager.ts',
		rule: 'W',
		target: 'fd',
		status: 'not-an-evidence-artifact',
		reason:
			'`writeFileSync(fd, …)` where the first argument is an open file ' +
			'DESCRIPTOR, not a path — the Node signature accepts `number | PathLike`. ' +
			'The descriptor comes from openSync on a ' +
			'plan.json.rebuild.<time>.<rand> temp file that is renamed onto ' +
			'plan.json, and that rename IS governed by RULE R.',
	},
];
