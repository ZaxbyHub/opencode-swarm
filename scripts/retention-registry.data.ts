/**
 * The complete retention and read-amplification registry (issue #2036).
 *
 * This is DATA, deliberately not prose: the CI check
 * (`scripts/check-retention-registry.ts`), the unit tests, and
 * `docs/observability-retention-registry.md` all assert against this single
 * artifact, mirroring the `EVENT_CATALOG` / `LEGACY_ADAPTER_RULES` precedent
 * from issue #2029. It lives under `scripts/` — NOT `src/` — so it can never
 * drift into the plugin bundle or the initialization path (AGENTS.md
 * invariants 1 and 2 are not touched by construction).
 *
 * Every row names a durable stream family on `main` @ `79fbf3ae` (the
 * fresh-main tree the 8+1-lane localization sweep verified; see the issue
 * trace). Line citations were verified against that tree and are
 * ungated — treat them as "verified as of" pointers, not standing
 * guarantees (the same caveat `docs/observability-event-contract.md` §6
 * carries). The mechanical guarantees are the writer-module coverage
 * ratchet and the disposition rules in the check script.
 *
 * Disposition rules (issue #2036): every row must end in exactly one of
 *   - fix-in-issue  — a linked implementation issue in the #2029–#2051
 *                     sequence, or sequence-amendment issue #2309;
 *   - retain-by-design — citing the authoritative durability/lifecycle
 *                     requirement plus bounded reader/close proof;
 *   - not-a-defect    — citing the source proof (bounded queue, batch-scoped
 *                     artifact, or hard byte bound).
 * `defer` / `unknown` / `TBD` / "future issue" are not completed rows and
 * fail the check.
 */

export type StateClass =
	| 'authoritative'
	| 'operational'
	| 'derived-rebuildable'
	| 'governed-content';

export type PrivacyClass = 'metadata' | 'content' | 'mixed';

export type LimitScope = 'global' | 'per-trigger' | 'per-key' | 'session-scoped' | 'none';

export type CanonicalRoot =
	| 'project-swarm'
	| 'platform-config'
	| 'xdg-cache'
	| 'worktree'
	| 'outside-swarm'
	| 'planned';

/**
 * Membership of a single flat `.swarm/` artifact in the two `/swarm close`
 * artifact arrays (`ARCHIVE_ARTIFACTS`, `ACTIVE_STATE_TO_CLEAN` in
 * `src/commands/close.ts`) — issue #1534 recurrence guardrail.
 *
 * These values describe ARRAY MEMBERSHIP ONLY, deliberately, because that is
 * what is mechanically checkable. They are NOT a summary of everything close
 * does to the file: `context.md` is `archive-only` here AND separately
 * rewritten to a stub, and `close-summary.md` is `archive-only` here because
 * it is written after the clean stage. The prose `closePolicy` field remains
 * the place for that narrative; this field is the machine-checked half.
 */
export type CloseArrayMembership =
	| 'archive+clean'
	| 'archive-only'
	| 'clean-only'
	| 'neither';

export type Disposition =
	| { kind: 'fix-in-issue'; issue: number; note: string }
	| { kind: 'retain-by-design'; citation: string }
	| { kind: 'not-a-defect'; proof: string };

export interface RetentionRow {
	/** Stable slug; must appear verbatim in the registry doc. */
	id: string;
	/** Issue #2036 category (1–9). */
	category: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
	/** Path grammar under the canonical root. */
	pathGrammar: string;
	canonicalRoot: CanonicalRoot;
	/**
	 * Source modules that own this stream's writes. The coverage ratchet in
	 * `check-retention-registry.ts` requires every writing module under
	 * `src/` to appear in exactly one row (or in EXEMPT_WRITER_MODULES).
	 */
	writerModules: readonly string[];
	/** Writer symbols with file:line citations. */
	writerCitations: readonly string[];
	/** Reader symbols with file:line + read-pattern citations. */
	readerCitations: readonly string[];
	schemaVersion: string;
	stateClass: StateClass;
	privacyClass: PrivacyClass;
	/**
	 * Issue #2483 ratchet rung 1 — a REVIEWED exemption for a row with
	 * `stateClass: 'authoritative'` whose `pathGrammar` is a direct-file
	 * store (does not route through `swarm.db`). The `reason` must restate
	 * the row's own durability justification — why the authority lives in a
	 * direct file and cannot migrate to the swarm.db surface — and
	 * `reviewedIssue` names the issue under which that durability decision
	 * was reviewed or the migration is owned (e.g. plan-ledger names #2484).
	 * Optional on the type; REQUIRED at check time by
	 * `collectRowShapeErrors` (scripts/check-retention-registry.ts) for
	 * every authoritative direct-file row.
	 */
	directFileExemption?: { reason: string; reviewedIssue: number };
	writeLimits: {
		/** Human-readable bound statement (constants + values). */
		bound: string;
		scope: LimitScope;
		/**
		 * What makes the KEYSPACE finite, with a path:line citation.
		 *
		 * Issue #2038 recurrence guardrail. A `scope: 'per-key'` cap bounds each
		 * KEY's history, not the STORE: steady-state size is
		 * O(distinct-keys x per-key-cap), so the row is bounded only if the set
		 * of keys is itself finite. In #2038 the key was `skillPath` and a
		 * 500-entry-per-skill prune was mistaken for a global bound while the
		 * set of skill paths was unbounded.
		 *
		 * A keyspace is finite iff EITHER the key domain is a closed set (an
		 * enum/union, or an index bounded by a max-concurrency constant) OR
		 * something deletes keys on a GLOBAL trigger. A per-key cap is never an
		 * answer to this field — it is the thing this field exists to qualify.
		 *
		 * Optional on the type because it is meaningless for
		 * global/per-trigger/session-scoped/none rows; `check-retention-registry.ts`
		 * REQUIRES it for per-key rows whose disposition is not fix-in-issue, and
		 * rejects a value that declares the keyspace unbounded (such a row is the
		 * #2038 defect class and must be fix-in-issue, not bounded-by-design).
		 */
		keyspaceBound?: string;
		citation: string;
	};
	readBound: {
		/** full-file | tail | line-bounded | indexed | directory-scan | write-only */
		pattern: string;
		// NOTE: `sync` satisfies the issue-required "sync/async behavior" column
		// as documentation-as-data for the doc/human rendering; the gate does not
		// (and need not) mechanically consume it.
		bound: string;
		sync: boolean;
		citation: string;
	};
	lockModel: string;
	crashBehavior: string;
	/** What `/swarm close` (finalize) does: archived+cleaned / archived-only / cleaned-only / untouched / rewritten-stub / n-a. */
	closePolicy: string;
	/**
	 * Issue #1534 recurrence guardrail — the machine-checked half of
	 * `closePolicy`. Maps each flat file this row owns DIRECTLY under `.swarm/`
	 * to its membership in close.ts's `ARCHIVE_ARTIFACTS` /
	 * `ACTIVE_STATE_TO_CLEAN` arrays, which
	 * `collectCloseLifecycleCoherenceErrors` (scripts/check-retention-registry.ts)
	 * verifies against the real arrays parsed out of close.ts.
	 *
	 * Optional on the TYPE because most rows own directories, templated paths,
	 * or state outside `.swarm/` and have nothing to declare. The gate REQUIRES
	 * it at check time for every `project-swarm` row whose `pathGrammar` names a
	 * literal flat `.swarm/<file>`, and requires every close.ts array entry to
	 * be declared by exactly one row — so an artifact cannot be wired into close
	 * without a registry row, nor registered without stating what close does
	 * with it. Keys are bare filenames (no `.swarm/` prefix).
	 */
	closeArrayMembership?: Readonly<Record<string, CloseArrayMembership>>;
	/** What `/swarm reset-session` and `/swarm reset` do. */
	resetPolicy: string;
	legacyCompatibility: string;
	healthSignal: string;
	/** Owning issue ("#NNNN") or "this-gate" for rows this PR ratifies. */
	owner: string;
	disposition: Disposition;
}

export const RETENTION_REGISTRY: readonly RetentionRow[] = [
	// ─────────────────────────────────────────────────────────────────────────
	// Category 1 — core telemetry and event streams
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'telemetry-jsonl',
		category: 1,
		pathGrammar: '.swarm/telemetry.jsonl (+ single rotated .1)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/telemetry.ts'],
		writerCitations: [
			'src/telemetry.ts:291 emit() — stream.write at :320',
			'src/telemetry.ts:250 initTelemetry() — createWriteStream append at :264',
			'src/telemetry.ts:366 rotateTelemetryIfNeeded() — renameSync at :394',
		],
		readerCitations: [
			'src/services/cost-accounting.ts:133 readTelemetryEvents — FULL-FILE both generations via temp-snapshot copy (:150,:164), sync',
			'src/evaluation/gate-stats.ts:65 telemetryStats — FULL-FILE readFileSync both generations (:75,:78), sync',
			'in-process addTelemetryListener heartbeat src/telemetry.ts:146-163 — no disk read',
		],
		schemaVersion: 'none (event discriminator only; lossy projection documented in docs/observability-event-contract.md §4)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'ROTATION_CHECK_INTERVAL=50 emits; rotate at 10 MiB (rotateTelemetryIfNeeded maxBytes, src/telemetry.ts:225,:367); exactly one .1 generation (renameSync overwrites)',
			scope: 'global',
			citation: 'src/telemetry.ts:225,367,394',
		},
		readBound: {
			pattern: 'full-file',
			bound: '≤ 2×10 MiB — both readers full-read but the rotation is a hard source-proven byte ceiling',
			sync: true,
			citation: 'src/telemetry.ts:367 (10 MiB) + cost-accounting.ts:137-140 (reads .1 then active)',
		},
		lockModel: 'none — single module-scoped write stream; rotation only from the throttled emit path',
		crashBehavior: 'append stream; torn trailing line tolerated (both readers JSON.parse try/catch); flushAndDrainTelemetry replaces stream handle before end() (src/telemetry.ts:438-469)',
		closePolicy: 'archived+cleaned — flush (src/commands/close/archive-stage.ts:161-204), ARCHIVE_ARTIFACTS (src/commands/close/constants.ts:50-51), ACTIVE_STATE_TO_CLEAN (src/commands/close/constants.ts:169-174)',
		closeArrayMembership: {
			'telemetry.jsonl': 'archive+clean',
			'telemetry.jsonl.1': 'archive+clean',
		},
		resetPolicy: 'reset-session does not touch it; /swarm close is the lifecycle boundary',
		legacyCompatibility: 'LEGACY_TELEMETRY_SOURCE_STORE (src/observability/legacy.ts:22); toLegacyTelemetryLine byte-identical projection (src/observability/observe.ts:334)',
		healthSignal: 'rotation events observable via file presence; consumers degrade on malformed lines',
		owner: '#2051 (legacy-path retirement/migration owner); this gate (ratification)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Hard 10 MiB rotation + single-archive continuity (src/telemetry.ts:367,394) bounds every full-file reader at ≤20 MiB — the issue-directed reading ("document single-archive continuity and later migration owner rather than calling it unbounded"). Legacy retirement is owned by #2051.',
		},
	},
	{
		id: 'events-jsonl',
		category: 1,
		pathGrammar: '.swarm/events.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/events/core-events.ts'],
		writerCitations: [
			'ONE canonical append seam — appendCoreEventSync (src/events/core-events.ts) — since issue #2039; every former direct writer (29 sites across 24 modules: curator, delegation-gate x3, pr-workflow-gate x5, pr-workflow-response-gate, full-auto intercept/delegation/input-probe, oversight, auto-review, adversarial-detector, delegation-sanitizer, knowledge gates x2, knowledge-curator, skill-propagation-gate, file-authority, role-filter, phase-complete, scope-persistence, rollback x2, lane-permissions, coder-settlement x2, stage-a-repair x2, checkpoint, spec-drift-recovery, prepare-pr-workflow-checkout x2, plan-manager spec_stale_detected, steering-consumed record) now calls the seam; scripts/check-core-events-usage.ts ratchets against new direct mentions',
			'src/events/core-events.ts appendCoreEventSync — per-write exclusive .swarm/events.lock (wx, 5-min stale-break), torn-tail re-framing, closed-set authority indexing',
		],
		readerCitations: [
			'src/events/core-events.ts readCoreEvents — tail-bounded (readMaxBytes 3 MiB), manifest-stripped, coverage complete/truncated/empty',
			'src/events/core-events.ts getCoreEventLifetimeCount — manifest folded.totalEvents + window count (context-budget turn proxy)',
			'src/events/core-events.ts getCoderRetryEscalationActions / hasSpecDriftAuditEvent / hasTaskRepairAuditEvent — authoritative index + bounded window fallback',
			'src/hooks/curator.ts runCuratorPhase — bounded window + filterPhaseEvents; truncated coverage disclosed via curator audit line',
			'src/tools/curator-analyze.ts — bounded window + filterPhaseEvents',
			'src/hooks/steering-consumed.ts createSteeringConsumedHook — bounded window set-diff',
			'src/services/diagnose-service.ts checkEventStreamIntegrity + checkSteeringDirectives — bounded window validation + coverage wording',
			'src/services/session-reflection.ts gatherLedgerRejections — live read via readCoreEvents; archived-copy fallback unchanged',
		],
		schemaVersion: 'v1 swarm-events-manifest header + retained window (issue #2039); event:/type: producer discriminators preserved unmodified',
		stateClass: 'operational',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'CORE_EVENT_LIMITS: activeMaxBytes 2 MiB (manifest+window), activeMaxEntries 20k, ageMaxMs 7d (operational entries; the closed authority set is exempt — it is INDEXED instead), compactMaxBytes 512 KiB/pass, checkInterval 25, maxLineBytes 256 KiB',
			scope: 'global',
			citation: 'src/events/core-events.ts CORE_EVENT_LIMITS (issue #2039)',
		},
		readBound: {
			pattern: 'manifest+retained-window (tail-bounded)',
			bound: 'readMaxBytes 3 MiB independent of total history; lifetime counts from the manifest header',
			sync: true,
			citation: 'src/events/core-events.ts readCoreEvents / getCoreEventLifetimeCount',
		},
		lockModel: 'exclusive .swarm/events.lock (wx create, 5-min mtime stale-break, bounded brief retry) held by EVERY write — appends, compaction, authority-index updates, finalize; the former per-site tryAcquireLock/proper-lockfile sentinels on this file are all removed (single-lock discipline, no nesting)',
		crashBehavior: 'atomic single-file rewrites (PID-scoped tmp + byte-verified rename; in-memory manifest/framing validation pre-rename); torn trailing line skipped + counted corrupt, re-framed on next append; legacy header-less files migrate in bounded fold passes',
		closePolicy: 'finalizeCoreEventsForClose under the store lock (legacy drain to convergence + compaction + validated cut) BEFORE the plain archive copy, then archived (ARCHIVE_ARTIFACTS) and cleaned (ACTIVE_STATE_TO_CLEAN) together with events-authority-index.json',
		closeArrayMembership: {
			'events.jsonl': 'archive+clean',
		},
		resetPolicy: 'reset-session unlinks events.jsonl + events-authority-index.json',
		legacyCompatibility: 'header-less files read bounded (newest window); authority lookups fall back to the retained-window scan so pre-store authority events stay answerable until folded; the fold pass indexes authority lines BEFORE removing them',
		healthSignal: 'core_events_health (counts-only: accepted/compacted/retained/dropped/corrupt/authority_index_count/authority_evicted_count + timestamps + bytes)',
		owner: '#2051 (legacy-path retirement/migration owner); #2039 shipped the bounded store',
		disposition: {
			kind: 'retain-by-design',
			issue: 2039,
			citation:
				'PR 11 shipped the bounded single-file store (src/events/core-events.ts manifest header + retained window under CORE_EVENT_LIMITS) with manifest-stripped bounded reads, the authoritative events-authority-index partition for the 4 correctness event types, per-write exclusive locking, a validated close cut, the core_events_health signal, and the check:core-events usage ratchet; verified by tests/unit/events/*.',
			note: 'PR 11 converted the formerly unbounded shared bus into the bounded store; the four correctness-relevant event types are answered from the authoritative index, never from the compactable window alone.',
		},
	},
	{
		id: 'events-authority-index',
		category: 1,
		pathGrammar: '.swarm/events-authority-index.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/events/core-events.ts'],
		writerCitations: [
			'src/events/core-events.ts mergeAuthorityKeys — atomic rewrite (tmp+rename) under the store lock; maintained at append time, fold time (BEFORE an authority line leaves the window), and read time (self-heal, lock-free)',
		],
		readerCitations: [
			'src/events/core-events.ts getCoderRetryEscalationActions — delegation-gate retry escalation verdicts',
			'src/events/core-events.ts hasSpecDriftAuditEvent — spec-drift WAL COMMITTED idempotency',
			'src/events/core-events.ts hasTaskRepairAuditEvent — task-repair audit idempotency',
		],
		schemaVersion: 'v1 {version, entries: Record<authorityKey, lastSeenTs>, evicted}',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'The authoritative index is maintained in lock-step with events.jsonl itself — mergeAuthorityKeys runs under the same store lock at append, fold, and read time; moving it into swarm.db would split one store\'s append/fold/index atomicity across two lock domains (issue #2039 requirement 2/5).',
			reviewedIssue: 2039,
		},
		writeLimits: {
			bound: 'authorityIndexMaxEntries 20k FIFO (~2 MiB worst case); eviction counted in the persisted evicted counter and disclosed via core_events_health',
			scope: 'global',
			citation: 'src/events/core-events.ts CORE_EVENT_LIMITS.authorityIndexMaxEntries (issue #2039)',
		},
		readBound: {
			pattern: 'indexed',
			bound: 'whole-file JSON read of the capped index (~2 MiB worst case); misses fall back to the bounded retained-window scan',
			sync: true,
			citation: 'src/events/core-events.ts loadAuthorityIndex + the three authority queries',
		},
		lockModel: 'writes under the exclusive .swarm/events.lock store lock (append/fold paths); read-time self-heal uses a lock-free atomic rewrite (idempotent last-write-wins)',
		crashBehavior: 'atomic tmp+rename rewrite; corrupt index => authority consumers fail CLOSED with a typed error (the malformed-JSONL throw contract they replace); append-then-index crash window self-heals at fold/read time (at most one benign duplicate audit line)',
		closePolicy: 'archived (ARCHIVE_ARTIFACTS) and cleaned (ACTIVE_STATE_TO_CLEAN) together with events.jsonl — the WAL dirs it dedupes for are cleaned at the same boundary; known narrow residual: an asymmetric archive failure (index copy fails while the events copy succeeds) preserves the index while events.jsonl is cleaned, so a future session reusing an exact taskId/retryEpoch could inherit a prior escalation verdict — the index is rebuildable and this requires that exact one-file I/O failure',
		closeArrayMembership: {
			'events-authority-index.json': 'archive+clean',
		},
		resetPolicy: 'reset-session unlinks it with events.jsonl',
		legacyCompatibility: 'absent file => empty index; the retained-window scan keeps legacy in-window authority events answerable, and the fold pass indexes them before compaction removes the lines',
		healthSignal: 'core_events_health authority_index_count / authority_evicted_count',
		owner: '#2039',
		disposition: {
			kind: 'retain-by-design',
			issue: 2039,
			citation:
				'The authoritative partition issue #2039 requirement 2/5 requires: correctness lookups never depend on the compactable operational window; the index is maintained at append, fold, and read time so compaction cannot change a gate verdict (FIFO eviction past 20k is the only reachable absence — disclosed, and its consequence is one benign duplicate audit line).',
			note: 'Growth mirrors the never-deleted-within-session WAL population (one tiny entry per repair/escalation/drift transition) and resets at close with the WAL dirs.',
		},
	},
	{
		id: 'context-telemetry',
		category: 1,
		pathGrammar: '.swarm/context-telemetry.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/context-map/telemetry.ts'],
		writerCitations: ['src/context-map/telemetry.ts recordTelemetry — appended into bounded single-file store; compaction/finalize atomic rewrite (issue #2037)'],
		readerCitations: [
			'src/context-map/telemetry.ts getTelemetrySummary/readTelemetry — bounded read (manifest header + retained window), capped at CONTEXT_TELEMETRY_LIMITS.readMaxBytes (issue #2037)',
			'src/commands/context-map-stats.ts:11 — sole non-test consumer of getTelemetrySummary',
		],
		schemaVersion: '2 (manifest header, issue #2037)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'ACTIVE_MAX_BYTES=256KiB / ACTIVE_MAX_ENTRIES=10k / AGE_MAX_MS=30d (retained raw window); lifetime folded aggregate in manifest header', scope: 'global', citation: 'src/context-map/telemetry.ts CONTEXT_TELEMETRY_LIMITS (issue #2037)' },
		readBound: { pattern: 'manifest+retained-window', bound: 'READ_MAX_BYTES=280KiB (independent of total history)', sync: true, citation: 'src/context-map/telemetry.ts readBoundedChunk (issue #2037)' },
		lockModel: 'single-synchronous-writer; exclusive .swarm/context-telemetry.lock (wx, stale-broken) guards compaction/cutover vs a second plugin instance (issue #2037)',
		crashBehavior: 'atomic single-file rewrite (tmp+rename) — no partial-apply state; torn final tail tolerated (JSON.parse try/catch); legacy migrates incrementally on write path (issue #2037)',
		closePolicy: 'archived via ARCHIVE_ARTIFACTS as a validated cut (finalizeContextTelemetry folds tail before copy); NOT in ACTIVE_STATE_TO_CLEAN — persists across sessions; compaction is the retention mechanism',
		closeArrayMembership: {
			'context-telemetry.jsonl': 'archive-only',
		},
		resetPolicy: 'not reset; persists',
		legacyCompatibility: 'pre-#2037 header-less JSONL migrated in bounded passes on the write/close path; retained raw window + lifetime aggregate are backward-compatible with existing field surface',
		healthSignal: 'context_telemetry_health (counts-only; accepted/compacted/retained/dropped/corrupt/oldest/newest/bytes), emitted on compaction & close (issue #2037)',
		owner: '#2037',
		disposition: {
			kind: 'retain-by-design',
			issue: 2037,
			citation:
				'PR 09 shipped the bounded single-file segmented store (src/context-map/telemetry.ts CONTEXT_TELEMETRY_LIMITS manifest header + retained window) with bounded reads (readBoundedChunk, READ_MAX_BYTES), atomic-rewrite compaction, a close finalize cut (close.ts ARCHIVE_ARTIFACTS), and the context_telemetry_health signal; verified by tests/unit/context-map/telemetry-bounded.test.ts.',
			note: 'PR 09 shipped the bounded single-file segmented store (manifest header + bounded retained window) with bounded reads, an atomic-rewrite compaction, a close finalize cut, and the context_telemetry_health signal.',
		},
	},
	{
		id: 'skill-usage',
		category: 1,
		pathGrammar:
			'.swarm/skill-usage.jsonl (+ .swarm/verdict-feedback-last-processed.json cursor)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/hooks/skill-usage-log.ts',
			'src/tools/phase-complete.ts',
		],
		writerCitations: [
			'src/hooks/skill-usage-log.ts:535 appendSkillUsageEntry — appendFileSync :624-628; enqueues into the sidecar FIRST (:614-621) before the JSONL append',
			'src/hooks/skill-usage-log.ts:1581 pruneSkillUsageLog — atomic temp+rename rewrite :1676-1681, applies applyRetention (:1022) and the marker-drop rewrite',
			'src/hooks/skill-usage-log.ts:326 appendFeedbackAppliedMarker — appendFileSync :341 (legacy pre-migration acknowledgment writer, retained for round-trip)',
		],
		readerCitations: [
			'src/hooks/skill-usage-log.ts:770 readSkillUsageEntries — bounded via readLogSlice :651-691, readMaxBytes=1,677,722 B, sync',
			'src/hooks/skill-usage-log.ts:745 readSkillUsageEntriesWithCoverage — same bound, additionally reports SkillUsageReadCoverage (truncatedRead + sidecar manifest coverage), sync',
			"src/hooks/skill-usage-log.ts:302 parseFeedbackMarker — parses feedback_applied markers during the migration's streaming acknowledgment pass (migrateLegacyLog pass 2, :1352-1371); legacy pre-migration reader only, sync",
			'src/hooks/skill-usage-log.ts:2095 applySkillUsageFeedback — reads the AUTHORITATIVE sidecar queue only (never the JSONL), async',
			'src/hooks/skill-usage-log.ts:808 readSkillUsageEntriesTail — TAIL 64 KiB (TAIL_BYTES_DEFAULT :782), sync',
			'src/services/session-reflection.ts:530 gatherSkillViolations — via tail reader',
		],
		schemaVersion: 'none on records (skillVersion versions the skill, not the record)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'HARD GLOBAL ceiling across all skills and marker types (issue #2038): maxEntries=5,000 / maxBytes=1.5 MiB / maxAgeMs=90d, with a per-skill floorPerSkill=20 guaranteed retained window; enforced by applyRetention (skill-usage-log.ts:1022-1123) on every compaction pass',
			scope: 'global',
			citation: 'src/hooks/skill-usage-pending.ts:86-101 SKILL_USAGE_LIMITS',
		},
		readBound: {
			pattern: 'mixed full-file + tail',
			bound: 'bounded — full readers capped at readMaxBytes=1,677,722 B (~1.6 MiB) via readLogSlice, which reports truncatedRead when a legacy oversized file is only partially read; tail reader 64 KiB (TAIL_BYTES_DEFAULT)',
			sync: true,
			citation: 'src/hooks/skill-usage-log.ts:651-691 readLogSlice; :782 TAIL_BYTES_DEFAULT',
		},
		lockModel: 'single shared .swarm/skill-usage.lock (openSync wx-create, stale-broken after SKILL_USAGE_LOCK_STALE_MS=5min); guards the sidecar and every migration/compaction touch of the JSONL; the enqueue path is exempt from skip-not-force and retries up to 5x/10ms, throwing (and aborting the append) on failure',
		crashBehavior: 'malformed JSONL lines skipped by JSON.parse try/catch (parseEntriesFromText :693-706); an overlong unassemblable line in the streaming reader is dropped and counted, not buffered without bound (streamLogLines :359-393); prune/compaction rewrite is atomic temp+rename (pruneSkillUsageLog :1581, rewrite :1676-1681); sidecar save is atomic temp+rename (savePendingDocument :796 -> savePendingDocumentAt, skill-usage-pending.ts:804-853, writeFileSync :821 + renameSync :822)',
		closePolicy: 'untouched — persists across sessions',
		closeArrayMembership: {
			'skill-usage.jsonl': 'neither',
			'verdict-feedback-last-processed.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'normalizeComplianceVerdict maps legacy violation→violated (skill-usage-log.ts:151-153); legacySkillUsageId mints a deterministic content-hash id for pre-id entries (:270-281); one-time migrateLegacyLog (:1291-1421) folds legacy actionable entries minus any feedback_applied-acknowledged ids into the sidecar; the whole migration runs on a staged copy that is published to the in-memory document only after savePendingDocument returns (stagePendingDocument :1209-1221 / adoptStagedDocument :1224-1233), so a failed sidecar write leaves the JSONL marker lines intact instead of dropping them ahead of a queue that was never written',
		healthSignal: 'skill_usage_health — counts-only (accepted/compacted/dropped/skills_dropped/corrupt/pending_retained/uncertain_retained/uncertain_expired/pending_evicted/no_source_knowledge/no_matching_knowledge/bump_retry/bump_unrecoverable/bump_applied_zero/pressure/curator_skipped/bytes/limit_bytes/oldest_timestamp/newest_timestamp/coverage), emitted on compaction/migration/consumption/pressure',
		owner: '#2038 (implemented)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Issue #2038 landed a hard global byte/age/count bound (SKILL_USAGE_LIMITS: maxEntries=5,000/maxBytes=1.5MiB/maxAgeMs=90d/floorPerSkill=20, src/hooks/skill-usage-pending.ts:85-101) enforced by applyRetention (src/hooks/skill-usage-log.ts:1022-1123), a bounded deterministic full reader (readLogSlice, :651-691, readMaxBytes=1,677,722 B) that reports truncatedRead rather than silently degrading, a shared stale-breakable lock (.swarm/skill-usage.lock, stale window SKILL_USAGE_LOCK_STALE_MS skill-usage-pending.ts:110), atomic temp+rename writes on both the JSONL compaction path (:1718-1723) and the new authoritative sidecar (skill-usage-pending.ts:803-853), and the skill_usage_health counts-only observability signal (skill-usage-pending.ts:1351-1385). The correctness gap the bound creates — an evicted-from-JSONL actionable verdict losing its feedback signal — is closed by enqueueSkillUsageFeedback (skill-usage-pending.ts:1171-1195), called BEFORE the JSONL append (skill-usage-log.ts:614-621) so eviction from the operational stream can never lose an un-consumed compliant/violated verdict; see the new skill-usage-pending row for that authoritative store\'s own bound. Enforcement is covered by tests/unit/hooks/skill-usage-bounds.test.ts (global ceiling, retention order, corrupt-line durability, migration) and tests/unit/hooks/skill-usage-pending.test.ts (queue budgets, terminal outcomes, quarantine), alongside tests/unit/hooks/skill-usage-log.test.ts and skill-usage-feedback.test.ts.',
		},
	},
	{
		id: 'skill-usage-pending',
		category: 1,
		pathGrammar: '.swarm/skill-usage-pending.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/skill-usage-pending.ts'],
		writerCitations: [
			'src/hooks/skill-usage-pending.ts:796 savePendingDocument — delegates to savePendingDocumentAt :804, writeFileSync tmp :820, renameSync :822 (atomic replace)',
			'src/hooks/skill-usage-pending.ts:1171 enqueueSkillUsageFeedback — under the lock, merges + bounds + saves (:1189-1191); the ONLY path exempt from skip-not-force (throws on lock failure)',
		],
		readerCitations: [
			'src/hooks/skill-usage-pending.ts:729 loadPendingDocument — via loadPendingDocumentAt :739, bounded by readMaxBytes=1,677,722 B (:757); oversized/corrupt documents are quarantined, never silently reset to empty (:781)',
			'src/hooks/skill-usage-pending.ts:864 readPendingManifest — cheap manifest-only read, statSync-mtime-keyed cache (:883-888), no records array materialized',
			'src/hooks/skill-usage-log.ts:745 readSkillUsageEntriesWithCoverage — folds readPendingManifest coverage into the JSONL read window',
			'src/hooks/skill-usage-log.ts:2095 applySkillUsageFeedback — sole consumer of the records array (via claimFeedbackRecords :-1-36), computes compliant/violated deltas from queue records only, never from JSONL entries',
		],
		schemaVersion: '1 (SKILL_USAGE_LIMITS.version, skill-usage-pending.ts:86)',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Sole durable record of un-consumed actionable skill-usage verdicts, deliberately a sidecar to the bounded JSONL operational stream so eviction from skill-usage.jsonl can never lose a correctness signal (issue #2038 requirement); the queue carries its own hard global bound (queueMaxRecords 5,000 / 512 KiB).',
			reviewedIssue: 2038,
		},
		writeLimits: {
			bound: 'queueMaxRecords=5,000 / queueMaxBytes=512 KiB / maxAgeMs=90d (shared with the JSONL age budget) / maxAttempts=5 transient-retry ceiling, enforced by enforceQueueBounds on every enqueue, migration, and consumption pass',
			scope: 'global',
			citation: 'src/hooks/skill-usage-pending.ts:86-101 SKILL_USAGE_LIMITS',
		},
		readBound: {
			pattern: 'indexed',
			bound: 'single JSON document bounded at readMaxBytes=1,677,722 B (~1.6 MiB); oversized reads are quarantined (renamed aside) and counted, never truncated in place',
			sync: true,
			citation:
				'src/hooks/skill-usage-pending.ts:729 loadPendingDocument, via loadPendingDocumentAt :740-789',
		},
		lockModel: 'single shared .swarm/skill-usage.lock (openSync wx-create, stale-broken after SKILL_USAGE_LOCK_STALE_MS=5min, skill-usage-pending.ts:110); enqueue is exempt from skip-not-force (acquireSkillUsageLockOrThrow :535-546, 5 attempts/10ms, throws and aborts the caller\'s append on failure); maintenance/consumption skip on lock failure, never force',
		crashBehavior: 'atomic temp+rename replace (savePendingDocument :796 -> savePendingDocumentAt :804-853, writeFileSync :821 + renameSync :822); a corrupt or oversized document is quarantined (renamed to a timestamped .corrupt- file) rather than silently discarded (quarantinePendingDocument :700-718, invoked from loadPendingDocumentAt :782); an in_flight record whose claim outlives the lock stale-break window is resolved to uncertain — survives, stays visible, never replayed (resolveStaleInFlight :1207-1228)',
		closePolicy: 'untouched — persists across sessions (same lifecycle as .swarm/skill-usage.jsonl, which it backs)',
		closeArrayMembership: {
			'skill-usage-pending.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'migrated: false on a fresh/absent document signals the one-time legacy migration has not run; migrateLegacyLog (skill-usage-log.ts:1291-1422) folds pre-existing JSONL actionable entries (minus feedback_applied-acknowledged ids) into this store on first lock-taking touch, then sets migrated: true',
		healthSignal: 'skill_usage_health — same counts-only payload as the skill-usage row (buildSkillUsageHealthPayload, skill-usage-pending.ts:1351-1385), emitted via emitSkillUsageHealth (:1389-1401)',
		owner: '#2038 (implemented)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'This store is deliberately AUTHORITATIVE, not derived-rebuildable: it is the sole durable record of which actionable (compliant/violated) skill-usage verdicts have not yet been folded into knowledge confidence via bumpKnowledgeConfidenceBatchResult (src/hooks/knowledge-store.ts:1293), driven by applySkillUsageFeedback (src/hooks/skill-usage-log.ts:2095-2183). Nothing else on disk records that fact once an entry is evicted from the bounded JSONL operational stream (issue #2038 requirement: eviction from skill-usage.jsonl must lose no correctness signal). It carries its own hard global bound (queueMaxRecords=5,000/queueMaxBytes=512KiB, src/hooks/skill-usage-pending.ts:85-101) enforced by enforceQueueBounds (:1024-1080, oldest-uncertain-first eviction; an actionable record evicted by the budget is counted as pending_evicted + pressure rather than dropped, a deliberate divergence from approved plan section 4 recorded in evictionRank docblock :981-1012 — every discard counted via the durable counters, never silent), atomic temp+rename writes (savePendingDocument :796 via savePendingDocumentAt :804-853), a shared stale-breakable lock, and the skill_usage_health signal. Enforcement is covered by tests/unit/hooks/skill-usage-pending.test.ts and tests/unit/hooks/skill-usage-bounds.test.ts.',
		},
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 2 — background delegation, PR monitor/feedback, lane sidecars
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'background-delegations-ledger',
		category: 2,
		pathGrammar: '.swarm/background-delegations.jsonl (+ .checkpoint.json + .manifest.json)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/background/pending-delegations.ts',
			'src/hooks/init-orphan-recovery.ts',
			'src/tools/prepare-pr-workflow-checkout.ts',
			'src/hooks/pr-workflow-gate.ts',
		],
		writerCitations: [
			'src/background/pending-delegations.ts:2958 appendRecord — SQLite coordination event+state transaction with post-commit JSON projection',
			'src/background/pending-delegations.ts:1442 writeDurableFileSync — fsync+rename-with-retry for legacy checkpoint/manifest/rolled-tail compatibility',
		],
		readerCitations: [
			'src/background/pending-delegations.ts:2866 readDelegations — SQLite authority with bounded legacy compatibility, sync',
			'src/background/pending-delegations.ts:2894 scanDelegationsForRecovery — strict, fails closed',
			'pr-workflow-session-resolver / pr-workflow-gate / init-orphan-recovery / delegation-gate worktree-collision-ownership — via readDelegations',
		],
		schemaVersion:
			'RecordSchema schemaVersion 1|2|3|4; checkpoint/manifest literal 1 (:1336,:1357,:1367)',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Cross-session recovery authority whose checkpoint/manifest projection must remain readable when the SQLite coordination store itself is the thing being recovered from; the #2034 checkpoint/tail compaction contract (1 MiB high-water, 4 MiB recovery bound) bounds the direct files.',
			reviewedIssue: 2034,
		},
		writeLimits: {
			bound: 'compaction high-water 1 MiB / low 256 KiB (:126-127); MAX_RECOVERY_LEDGER_BYTES 4 MiB (delegation-health.ts:35); MAX_CHECKPOINT_BYTES 2 MiB / 2048 records (:129,:133); TOMBSTONE_MIN_AGE 72 h (:144)',
			scope: 'global',
			citation: 'src/background/pending-delegations.ts:126-144; src/background/delegation-health.ts:35 (#2034)',
		},
		readBound: {
			pattern: 'indexed (checkpoint+tail) with full-fold fallback',
			bound: 'legacy/tail reads hard-bounded at 4 MiB (MAX_RECOVERY_LEDGER_BYTES)',
			sync: true,
			citation: 'src/background/pending-delegations.ts:112-117,1886',
		},
		lockModel: 'withEvidenceLock agent=background on every mutation (:170-173); reads lock-free',
		crashBehavior:
			'torn append tolerated by lenient fold, strict recovery fails closed; manifest-gated checkpoint publication — checkpoint without manifest ignored (:1614-1626)',
		closePolicy: 'archived-only — ARCHIVE_ARTIFACTS (src/commands/close/constants.ts:75-77); deliberately NOT cleaned (cross-session store; compaction is the bounded-retention mechanism, src/commands/close/constants.ts:70-78 docblock)',
		closeArrayMembership: {
			'background-delegations.jsonl': 'archive-only',
			'background-delegations.checkpoint.json': 'archive-only',
			'background-delegations.manifest.json': 'archive-only',
		},
		resetPolicy: 'reset/reset-session do not delete',
		legacyCompatibility:
			'legacy checkpoint/ledger is validated and imported once into SQLite, then cold-archived with JSON retained as a compatibility projection (:1886)',
		healthSignal: 'delegation-health artifact + #2034 recovery observations',
		owner: '#2034 (merged)',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Bounded by the #2034 checkpoint/tail compaction contract: 1 MiB high-water global trigger, 4 MiB hard recovery bound, 2 MiB/2048-record checkpoint validation, 72 h tombstone floor (src/background/pending-delegations.ts:126-144; src/background/delegation-health.ts:35).',
		},
	},
	{
		id: 'background-delegations-health',
		category: 2,
		pathGrammar: '.swarm/background-delegations-health.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/delegation-health.ts'],
		writerCitations: ['src/background/delegation-health.ts:332 writeDelegationHealthArtifact — temp+rename-retry'],
		readerCitations: ['src/background/delegation-health.ts:309 readDelegationHealthArtifact — single-file, sync; :539 collectDelegationLedgerHealth'],
		schemaVersion: 'schemaVersion 1 (:250)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'bounded by described data (checkpoint/ledger bounds above)', scope: 'global', citation: 'src/background/delegation-health.ts:35' },
		readBound: { pattern: 'indexed', bound: 'single small JSON artifact', sync: true, citation: 'src/background/delegation-health.ts:309' },
		lockModel: 'written under the store lock (compaction/recovery) or best-effort',
		crashBehavior: 'atomic rename with 5×15 ms Windows retry; best-effort, returns null on failure (:419)',
		closePolicy: 'archived-only — ARCHIVE_ARTIFACTS (src/commands/close/constants.ts:78), not cleaned',
		closeArrayMembership: {
			'background-delegations-health.json': 'archive-only',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'malformed/missing → null',
		healthSignal: 'IS the health signal (recovery pressure, late terminals, uncertainty)',
		owner: '#2034 (merged)',
		disposition: { kind: 'not-a-defect', proof: 'Single rewritten bounded artifact describing already-bounded stores; atomic + fail-open (src/background/delegation-health.ts:332,420).' },
	},
	{
		id: 'learning-health-artifact',
		category: 2,
		pathGrammar: '.swarm/learning-health.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/health/learning-health.ts'],
		writerCitations: [
			'src/health/learning-health.ts persistLearningHealth — atomicWriteSwarmFile, fire-and-forget, debounced 5 s (transitions force)',
		],
		readerCitations: [
			'src/health/learning-health.ts readLearningHealth — rehydrate + lazy window evaluation; readers: src/services/status-service.ts (Learning Health section) and src/services/diagnose-service.ts (learning-health check)',
		],
		schemaVersion: 'schemaVersion 1',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: '≤64 scopes/alarm × 8 alarms compact counters + ≤100-transition ring; no fact lists persisted',
			scope: 'global',
			citation: 'src/health/learning-health.ts MAX_HEALTH_SCOPES/MAX_FACTS_PER_SCOPE/MAX_TRANSITION_RING',
		},
		readBound: { pattern: 'indexed', bound: 'single small JSON artifact', sync: false, citation: 'src/health/learning-health.ts readLearningHealth' },
		lockModel: 'lock-free last-writer-wins per project directory (atomic rename)',
		crashBehavior: 'atomic temp+rename via atomicWriteSwarmFile; best-effort, a lost write loses only visibility, never alarm truth (producers re-observe)',
		closePolicy: 'not archived or cleaned — operational health artifact; deletion loses visibility only',
		closeArrayMembership: {
			'learning-health.json': 'neither',
		},
		resetPolicy: 'not reset (health transitions are incident-reconstruction facts)',
		legacyCompatibility: 'malformed/missing → empty snapshot; schemaVersion mismatch → ignored',
		healthSignal: 'IS the health signal (learning/operations alarm transitions #2044)',
		owner: '#2044',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Persisted content is alarm transitions + compact per-scope counters only — explicitly NOT invocation-owned transient-retry or nonTransientCircuit state (issue #2044 item 9); bounded rings, salted session refs, atomic writes (src/health/learning-health.ts).',
		},
	},
	{
		id: 'background-delegations-fallback',
		category: 2,
		pathGrammar: '.swarm/background-delegation-fallback/*.json + .swarm/background-coder-reservations.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/pending-delegations.ts'],
		writerCitations: [
			'src/background/pending-delegations.ts:5190 writeDelegationFallback / :5241 removeDelegationFallback',
			'src/background/pending-delegations.ts:5670 writeBackgroundCoderReservations',
		],
		readerCitations: [
			'src/background/pending-delegations.ts:5045 readDelegationFallback / :5057 listDelegationFallbacks / :5091 scanDelegationFallbacksForRecovery',
			'src/background/pending-delegations.ts:5648 scanBackgroundCoderReservationsForAdmission',
		],
		schemaVersion: 'fallback schemaVersion 1 (:971)',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Fallback authority exists precisely for the case where the SQLite coordination store is unavailable — promoting fallback records into swarm.db on the recovery path is the design; hard capacity bounds (256 artifacts / 1 MiB each, 256 reservations / 2 MiB) keep the direct files bounded meanwhile.',
			reviewedIssue: 2034,
		},
		writeLimits: {
			bound: 'MAX_LIVE_BACKGROUND_FALLBACKS 256 (:82); per-file 1 MiB (:95); reservations ≤256 entries / 2 MiB store (:83, :4808)',
			scope: 'global',
			citation: 'src/background/pending-delegations.ts:82-95,4808',
		},
		readBound: { pattern: 'directory-scan', bound: '≤256 files × 1 MiB', sync: false, citation: 'src/background/pending-delegations.ts:4465-4598' },
		lockModel: 'separate lock tasks FALLBACK_LOCK_TASK / RESERVATION_LOCK_TASK (:147-148)',
		crashBehavior: 'bunWrite single-file artifacts; strict recovery scans fail closed',
		closePolicy: 'untouched (cross-session recovery state)',
		closeArrayMembership: {
			'background-coder-reservations.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'recovery scans report fallback promotion',
		owner: '#2034 (merged)',
		disposition: { kind: 'not-a-defect', proof: 'Hard capacity bounds: 256 fallback artifacts / 1 MiB each, 256 reservations / 2 MiB store, enforced on write and scan (src/background/pending-delegations.ts:82-95,4808).' },
	},
	{
		id: 'pr-monitor-subscriptions',
		category: 2,
		pathGrammar:
			'.swarm/pr-monitor/subscriptions.checkpoint.json (+ bounded subscriptions.audit.jsonl transition tail; transient legacy subscriptions.jsonl → subscriptions.legacy.jsonl archive, TTL-deleted, with bounded .next/.previous replacement slots; single quarantine slots subscriptions.checkpoint.foreign.json / .corrupt.json and subscriptions.legacy.foreign.jsonl)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/pr-subscriptions.ts'],
		writerCitations: [
			'src/background/pr-subscriptions.ts writeCheckpointFile — atomic tmp+rename (atomicWriteSwarmFileSync) under withEvidenceLock on the unchanged v1 lock key; all mutations (subscribe/unsubscribe/updateSnapshot/sweepStale/migration/archive) serialize cross-process (issue #2042)',
			'src/background/pr-subscriptions.ts flushAuditEvents/planAuditCompaction/applyAuditCompaction — transition-only audit appends; compaction reads at most the 128 KiB high-water tail and rewrites newest ≤250 lines / ≤64 KiB',
		],
		readerCitations: [
			'src/background/pr-subscriptions.ts loadViewForRead — bounded checkpoint read (live-set sized); lock-free; legacy overlay only while a legacy source is pending or changed (streaming, bounded memory); one-time read-bootstrap persists the first checkpoint so read-only installs converge (issue #2042)',
			'src/background/pr-subscriptions.ts getPrSubscriptionHealth — bounded health read (counts/bytes/pressure/recovery-source)',
		],
		schemaVersion: 'checkpoint schemaVersion 1 (records map + migration cursor + maintenance counters)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'live-subscription cap: explicit maxSubscriptions (config default 20, max 100 — src/config/schema.ts) with store-side safety net default 20 when the caller omits it (PR_SUBSCRIPTION_LIMITS.defaultMaxActiveSubscriptions); terminal records compacted 60-high→30-newest + 30-day age into monotone terminalSummary counters; checkpoint pressure-guard 256 KiB (reporting-only — active records never dropped for bytes) with HARD read-side guards (512-record replay guard + 1 MiB UTF-8 byte ceiling → invalid/quarantine/legacy-recovery, never a synchronous over-ceiling load); audit tail 500-line/128 KiB high-water → 250-line/64 KiB low-water rewrite, with compaction reading at most the 128 KiB tail; legacy sources have a 64 MiB admission ceiling and migration folds at most 8 MiB per mutation in 1 MiB crash-resumable progress chunks (larger admitted sources return a retryable progress error; an over-ceiling source is refused before any mutation/checkpoint publication, never folded, never archived, and disclosed via health + the /swarm pr status footer with a repair hint); the replay guards are WRITER-enforced too — terminal compaction runs before every persist and a folded live set that still exceeds the 512-record/1 MiB replay capacity refuses migration and fails writes with a loud capacity error while reads keep folding the legacy source exactly (never persisting a checkpoint the reader would reject, never archiving unabsorbed data); foreign checkpoint plus co-copied legacy pairs are quarantined to bounded single-file slots before local state is published',
			scope: 'global',
			citation: 'src/background/pr-subscriptions.ts PR_SUBSCRIPTION_LIMITS (#2042 shipped)',
		},
		readBound: { pattern: 'bounded-checkpoint-read', bound: 'checkpoint is live-set sized (≤512-record guard, ~tens typical); legacy tail fold only while a legacy source exists and changed — never lifetime history after migration', sync: true, citation: 'src/background/pr-subscriptions.ts loadViewForRead/foldLegacyRegion' },
		lockModel: 'withEvidenceLock agent=pr-monitor on the unchanged v1 key (PR_SUBSCRIPTIONS_FILE); reads lock-free except the one-time best-effort read-bootstrap (5 s lock timeout)',
			crashBehavior: 'atomic tmp+rename checkpoint writes; migration progress persisted per 1 MiB chunk and yields after ≤8 MiB per mutation (resumable cursor); quarantine → checkpoint write → audit append ordering; crash-after-archive repaired idempotently; corrupt checkpoints are quarantined and recovered from the legacy log, while foreign checkpoint plus legacy pairs are quarantined together before a project-local rebind',
		closePolicy: 'untouched (bounded at write; terminal/audit compaction + archive TTL own reaping)',
		resetPolicy: 're-subscribe overwrites per correlationId; foreign/corrupt recovery rebinds (maintenance.resets counted, quarantined copy retained); operator may delete the archive/quarantine files',
		legacyCompatibility: 'pre-#2042 append-only subscriptions.jsonl migrated incrementally under bounded bytes/work; v1 positional last-line-wins preserved (overlay tie → legacy-fold result wins); malformed/oversize lines skipped and counted, never silently dropped',
		healthSignal: 'pr_subscription_health (trigger compact/migrate-complete/archive/foreign-rebind/corrupt-quarantine; counts only) + /swarm pr status storage footer + getPrSubscriptionHealth',
		owner: '#2042',
		disposition: {
			kind: 'retain-by-design',
			citation: 'Bounded at write by the #2042 shipped implementation (checkpoint + transition-audit tail + incremental legacy migration + terminal compaction); the retained live set IS the PR-monitor contract, and terminal history reduces to bounded counters + bounded audit summaries.',
		},
	},
	{
		id: 'pr-feedback-event-queues',
		category: 2,
		pathGrammar: '.swarm/pr-feedback-events/{session-stem}.json (+ .lock)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/pr-feedback-event-queue.ts'],
		writerCitations: ['src/background/pr-feedback-event-queue.ts:242 writeQueueRecord — atomic temp+fsync+Windows-retry rename (enqueue/claim)'],
		readerCitations: ['src/background/pr-feedback-event-queue.ts:441 readPrFeedbackMonitorQueueFromDisk — bounded ≤512 KiB with identity verification, async'],
		schemaVersion: 'schemaVersion 1 (:35)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_PR_FEEDBACK_MONITOR_EVENTS 20 per queue (:14); MAX_QUEUE_BYTES 512 KiB per file (:15); in-memory cache MAX_TRACKED_SESSIONS 200 FIFO (:16); the retention sweep\'s pr-feedback-events family age-prunes every queue file at 30 d (src/retention/sweep.ts:91)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: the retention-sweep family pr-feedback-events (src/retention/sweep.ts:91) age-prunes every session queue file at 30 d — wired post-init (src/index.ts:1293) and pre-close (src/commands/close/orchestrator.ts:269-286) — so the session-file keyspace cannot outgrow the sweep horizon. The in-process MAX_TRACKED_SESSIONS=200 FIFO (src/background/pr-feedback-event-queue.ts:16) remains an in-memory bound only. This closes the #2038-class keyspace gap this row recorded under #2309.',
			citation: 'src/background/pr-feedback-event-queue.ts:14-19; src/retention/sweep.ts:91',
		},
		readBound: { pattern: 'indexed', bound: '≤512 KiB hard read bound', sync: false, citation: 'src/background/pr-feedback-event-queue.ts:440-470' },
		lockModel: 'per-session wx lock file with PID liveness reclamation (:284-383); promise-chained mutations (:254)',
		crashBehavior: 'crash between temp and rename leaves no destination; next write retries cleanly',
		closePolicy: 'untouched — the 30 d retention sweep owns the queue-file reap',
		resetPolicy: 'not reset',
		legacyCompatibility: 'QueueRecordSchema rejects non-matching shapes',
		healthSignal: 'lock reclamation counters',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 retention sweep\'s pr-feedback-events family age-prunes every session queue file at 30 d (src/retention/sweep.ts:91), wired post-init (src/index.ts:1293) and pre-close (src/commands/close/orchestrator.ts:269-286) — the keyspace gap behind the #2309/#2038 reclassification is closed; per-file caps 20 events / 512 KiB (src/background/pr-feedback-event-queue.ts:14-15) bound each key.',
		},
	},
	{
		id: 'lane-results-outputs',
		category: 2,
		pathGrammar: '.swarm/lane-results/{batchDigest}/{laneDigest}/{outputDigest}.json + candidates.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/lane-output-store.ts', 'src/background/candidate-sidecar-store.ts'],
		writerCitations: [
			'src/background/lane-output-store.ts:84 storeLaneOutput — atomic temp+rename :355',
			'src/background/candidate-sidecar-store.ts:458 appendToSidecar — appendFileSync :506 (optional lockfile :509-513)',
		],
		readerCitations: [
			'src/background/lane-output-store.ts:191 readLaneOutput — single-file by ref with digest/bytes validation, sync',
			'candidates parsed by consumers (parseCandidates via pr-workflow-gate.ts:19)',
		],
		schemaVersion: 'LANE_OUTPUT_SCHEMA_VERSION 1 (lane-output-store.ts:16); candidates carry row_format_version/record_version per record',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'MAX_LANE_OUTPUT_STORED_BYTES 10 MiB PER-FILE (lane-output-store.ts:15, degraded beyond); candidates.jsonl rides its batch directory; the retention sweep prunes lane-results at 30 d age AND keeps only the newest 100 batches (LANE_RESULTS_KEEP_NEWEST_BATCHES, src/retention/sweep.ts:48,97)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: the retention-sweep family lane-results prunes batch directories at 30 d age AND enforces a keep-newest-100 count cap (LANE_RESULTS_KEEP_NEWEST_BATCHES, src/retention/sweep.ts:48,97), taking each batch\'s candidates.jsonl with its directory — the batch keyspace is bounded by both age and count on a global trigger.',
			citation: 'src/background/lane-output-store.ts:15; src/retention/sweep.ts:97',
		},
		readBound: { pattern: 'indexed', bound: 'per-artifact 10 MiB write ceiling; candidates full-parse per batch (each batch ≤30 d old by the sweep)', sync: true, citation: 'src/background/lane-output-store.ts:15,191' },
		lockModel: 'none cross-process (rename winner nondeterministic but valid); optional proper-lockfile on batch dir for candidates',
		crashBehavior: 'atomic rename for outputs; torn append possible for candidates',
		closePolicy: 'untouched by close — the retention sweep owns the 30 d / newest-100 batch reap',
		resetPolicy: 'not reset',
		legacyCompatibility: 'schema-validated on read; rejects mismatches',
		healthSignal: 'degraded flag on oversize outputs',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 retention sweep\'s lane-results family prunes batches at 30 d age AND keeps only the newest 100 (LANE_RESULTS_KEEP_NEWEST_BATCHES, src/retention/sweep.ts:48,97), deleting each batch\'s candidates.jsonl with its directory — the #2045 accumulation gap is closed by the sweep.',
		},
	},
	{
		id: 'lane-delivery-cache',
		category: 2,
		pathGrammar: '.swarm/lane-delivery-cache.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/lane-delivery-store.ts'],
		writerCitations: ['src/background/lane-delivery-store.ts — rewrite of delivered-output dedupe keys (bounded maps)'],
		readerCitations: ['src/background/lane-delivery-store.ts:99 readFileSync — single file, sync'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_DELIVERED_LANE_OUTPUT_KEYS 1024 (:35); MAX_TRACKED_SESSIONS 16 (:36); MAX_TRACKED_DIRECTORIES 16 (:37-40) with FIFO eviction (:165-204)',
			scope: 'global',
			citation: 'src/background/lane-delivery-store.ts:23-40,165-204',
		},
		readBound: { pattern: 'indexed', bound: 'single bounded JSON', sync: true, citation: 'src/background/lane-delivery-store.ts:98' },
		lockModel: 'in-process bound enforcement (invariant 8 pattern)',
		crashBehavior: 'rewrite; stale cache at worst re-delivers',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'lane-delivery-cache.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Hard bounds 1024 keys / 16 sessions / 16 directories with eviction (src/background/lane-delivery-store.ts:35-40,165-204).' },
	},
	{
		id: 'lane-receipt-recovery-cursor',
		category: 2,
		pathGrammar: '.swarm/lane-receipt-recovery-cursor.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/delegation-lifecycle.ts'],
		writerCitations: [
			'src/background/delegation-lifecycle.ts writeRecoveryCursor — JSON.stringify of {updatedAt, correlationId} via fs.writeFileSync; reset via fs.rmSync force (issue #2045 terminal-lane receipt recovery)',
		],
		readerCitations: [
			'src/background/delegation-lifecycle.ts readRecoveryCursor — single file, sync, validated manual guards (fail-open to null)',
		],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'one fixed-shape object ({updatedAt: number, correlationId: string ≤256}); overwritten in place each advancing pass; no accumulation',
			scope: 'global',
			citation: 'src/background/delegation-lifecycle.ts RecoveryCursor + writeRecoveryCursor',
		},
		readBound: { pattern: 'indexed', bound: 'single bounded JSON', sync: true, citation: 'src/background/delegation-lifecycle.ts readRecoveryCursor' },
		lockModel: 'in-process bound enforcement (invariant 8 pattern); cross-process cursor races degrade to ledger-idempotent rework only',
		crashBehavior: 'rewrite; a lost/stale cursor only causes idempotent replay rework (receipt ledger dedupes), never corruption',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'lane-receipt-recovery-cursor.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Fixed two-field shape rewritten per recovery pass (src/background/delegation-lifecycle.ts readRecoveryCursor/writeRecoveryCursor); loss is fail-open to idempotent rework, bounded by MAX_TERMINAL_LANE_RECEIPT_RECOVERY + admission deadline.' },
	},
	{
		id: 'workspace-snapshot-digest',
		category: 2,
		pathGrammar: '.swarm/workspace-snapshot.digest',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/workspace-snapshot.ts'],
		writerCitations: [
			'src/background/workspace-snapshot.ts:1918 captureWorkspaceSnapshotAsync — async twin persist path: after a successful capture the content digest is written to the .swarm-contained marker (:1967-1978)',
			'src/background/workspace-snapshot.ts:1970 atomicWriteSwarmFile — validateSwarmPath(SNAPSHOT_DIGEST_MARKER_FILENAME)-contained atomic temp+rename; advisory by contract, a containment rejection or write failure never fails the capture (:1974-1977)',
		],
		readerCitations: [
			'src/background/workspace-snapshot.ts:1992 shouldSkipSnapshot — single readFileSync of the marker, trim + exact compare; missing/malformed marker or candidate digest fails open to false (a skip can never suppress a capture)',
		],
		schemaVersion: 'none — single sha256 hex line (64 lowercase hex chars + trailing newline)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'ONE fixed-shape advisory marker per project root — 65 bytes (64-char sha256 hex + newline), atomically overwritten per capture; the write is skipped entirely whenever the digest is unchanged, so footprint is constant regardless of capture frequency',
			scope: 'global',
			citation: 'src/background/workspace-snapshot.ts:1967-1978',
		},
		readBound: { pattern: 'line-bounded', bound: 'single 65-byte marker read once per capture', sync: true, citation: 'src/background/workspace-snapshot.ts:1992-2005' },
		lockModel: 'none — advisory marker; atomic temp+rename makes concurrent captures last-writer-wins and a raced stale value costs one redundant capture at worst',
		crashBehavior: 'atomic temp+rename; a torn or lost marker fails open (shouldSkipSnapshot false) and the next capture rewrites it — the marker is advisory, never authoritative state',
		closePolicy: 'archived then cleaned by /swarm close — the marker is a member of both ARCHIVE_ARTIFACTS and ACTIVE_STATE_TO_CLEAN (close.ts), so close preserves a copy in the archive and removes the live file',
		closeArrayMembership: {
			'workspace-snapshot.digest': 'archive+clean',
		},
		resetPolicy: 'not reset — a stale marker after any reset merely fails open to a full capture',
		legacyCompatibility: 'pre-marker installs simply capture and write on first use; a malformed marker reads as a mismatch (skip=false)',
		healthSignal: 'n/a (advisory skip marker; effectiveness is observable only as avoided writes)',
		owner: '#2472',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Single fixed-shape 65-byte advisory marker, atomically overwritten per capture and skipped entirely when the content digest is unchanged; a missing, torn, or stale marker costs exactly one redundant capture because shouldSkipSnapshot fails open — constant footprint, no accumulation vector (src/background/workspace-snapshot.ts:1967-1978,1992-2005).',
		},
	},
	{
		id: 'pr-review-reentry-authorizations',
		category: 2,
		pathGrammar: '.swarm/pr-review/reentry-authorizations/{session-stem}.json (+ .lock)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/pr-review/authorization.ts'],
		writerCitations: [
			'src/pr-review/authorization.ts writeAuthorizationFile — atomic temp+rename, proper-lockfile guarded, ≤64 KiB write bound',
		],
		readerCitations: [
			'src/pr-review/authorization.ts readAuthorizationFile — bounded single-file read, ≤64 KiB',
		],
		schemaVersion: 'schemaVersion 1 (Zod-validated file + records)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'per-session: ≤8 unconsumed authorizations, ≤32 persisted records (pruned on write), 10-min TTL; store file ≤64 KiB; the shadow-projection files age-prune at 30 d via the retention sweep (src/retention/sweep.ts:92)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: the retention sweep\'s pr-review-reentry-shadows family age-prunes every session shadow-projection file at 30 d (src/retention/sweep.ts:92) without ever touching the coordination_state SQLite authority — the file keyspace is bounded by the sweep horizon while the authority stays in swarm.db.',
			citation: 'src/pr-review/authorization.ts AUTHORIZATION_TTL_MS/MAX_ACTIVE_AUTHORIZATIONS/MAX_PERSISTED_AUTHORIZATIONS/REENTRY_AUTHORIZATIONS_MAX_BYTES; src/retention/sweep.ts:92',
		},
		readBound: { pattern: 'indexed', bound: 'single session file, 64 KiB hard read bound', sync: false, citation: 'src/pr-review/authorization.ts readAuthorizationFile' },
		lockModel: 'proper-lockfile (stale 10 s, update 1 s) on the session store file',
		crashBehavior: 'atomic temp+rename; a torn write loses an unconsumed authorization only (consume fails closed to normal gating)',
		closePolicy: 'untouched by close — the 30 d sweep owns the shadow-file reap; the coordination_state authority rides the project-db row',
		resetPolicy: 'not reset',
		legacyCompatibility: 'absent store reads as null (fail-closed normal gating)',
		healthSignal: 'consume-time binding mismatch (stale/expired/replayed) returns null',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Per-session content was already bounded (≤8 unconsumed / ≤32 persisted, on-write pruning, 10-min TTL, 64 KiB file — src/pr-review/authorization.ts); the #2483 retention sweep\'s pr-review-reentry-shadows family (src/retention/sweep.ts:92) now age-prunes every session file at 30 d without touching the coordination_state authority, closing the keyspace gap behind the #2309 row.',
		},
	},
	{
		id: 'pr-review-run-artifacts',
		category: 2,
		pathGrammar: '.swarm/pr-review/{run_id}/{findings.jsonl, feedback-handoff.json, trigger-eval.json}',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/tools/write-pr-review-artifact.ts',
			'src/tools/write-pr-review-trigger-eval.ts',
			'src/background/pr-feedback-event-queue.ts',
			'src/review/evidence.ts',
		],
		writerCitations: [
			'src/tools/write-pr-review-artifact.ts:198/:255 — findings JSONL append (≤1000 records/call) + handoff JSON, atomic',
			'src/tools/write-pr-review-trigger-eval.ts:574-591 — atomic write, refuses overwrite (:567-570)',
			'src/background/pr-feedback-event-queue.ts:331 — feedback-handoff lock/content writes',
		],
		readerCitations: ['src/tools/write-pr-review-artifact.ts:86-101 readFindings — 10 MiB read guard'],
		schemaVersion: 'per-artifact schemas (Zod-validated rows)',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'per-run: findings ≤1000 records/call + 10 MiB read guard; run directories age-prune at 30 d via the retention sweep (src/retention/sweep.ts:95)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: the retention sweep\'s pr-review-run-artifacts family age-prunes .swarm/pr-review/ run directories at 30 d (src/retention/sweep.ts:95), so the run-id keyspace cannot outgrow the sweep horizon.',
			citation: 'src/tools/write-pr-review-artifact.ts:60,89; src/retention/sweep.ts:95',
		},
		readBound: { pattern: 'line-bounded', bound: '10 MiB read guard', sync: true, citation: 'src/tools/write-pr-review-artifact.ts:89' },
		lockModel: 'artifact-boundary assertions rather than file locks',
		crashBehavior: 'atomic temp+rename',
		closePolicy: 'untouched by close — the 30 d sweep owns the run-dir reap',
		resetPolicy: 'not reset',
		legacyCompatibility: 'records matched against authoritative verdicts on read',
		healthSignal: 'boundary assertion failures',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Per-run artifacts were already individually bounded (≤1000 records/call + 10 MiB read guard, src/tools/write-pr-review-artifact.ts:60,89); the #2483 retention sweep\'s pr-review-run-artifacts family (src/retention/sweep.ts:95) now age-prunes the run directories at 30 d, closing the no-lifecycle-decision gap behind the #2309 row.',
		},
	},
	{
		id: 'status-artifacts',
		category: 2,
		pathGrammar: '.swarm/automation-status.json + .swarm/evidence-summary.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/background/status-artifact.ts', 'src/background/evidence-summary-integration.ts'],
		writerCitations: [
			'src/background/status-artifact.ts:178 AutomationStatusArtifact.write — plain writeFileSync (6 mutation entry points)',
			'src/background/evidence-summary-integration.ts:70 — writeFileSync artifact',
		],
		readerCitations: ['src/background/status-artifact.ts:162 load — single file, sync, fail-open re-init'],
		schemaVersion: 'none (status-artifact); evidence-summary integration-managed',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten snapshot (filename ≤255 chars :66)', scope: 'global', citation: 'src/background/status-artifact.ts:66,178-184' },
		readBound: { pattern: 'indexed', bound: 'single small JSON', sync: true, citation: 'src/background/status-artifact.ts:162' },
		lockModel: 'none; fail-open (parse failure → fresh snapshot)',
		crashBehavior: 'non-atomic writeFileSync; truncated file self-heals to fresh snapshot on next load (:140-149)',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'automation-status.json': 'neither',
			'evidence-summary.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'reader returns null on any parse failure',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single rewritten bounded snapshot with fail-open re-init; no growth dimension (src/background/status-artifact.ts:140-184).' },
	},
	{
		id: 'locks-dir',
		category: 2,
		pathGrammar: '.swarm/locks/{sha256|.base64}.lock + .meta sidecars',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/parallel/file-locks.ts'],
		writerCitations: ['src/parallel/file-locks.ts:143 tryAcquireLock (sentinel + proper-lockfile dir); :109 writeMetaFile temp+rename'],
		readerCitations: ['src/parallel/file-locks.ts:303 listActiveLocks — directory scan filtering expired, sync'],
		schemaVersion: 'n/a',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'LOCK_TIMEOUT_MS 5 min stale expiry; cleanupExpiredLocks sweep (:250-297)', scope: 'global', citation: 'src/parallel/file-locks.ts:7,250-297' },
		readBound: { pattern: 'directory-scan', bound: 'live locks only (expired filtered)', sync: true, citation: 'src/parallel/file-locks.ts:303-369' },
		lockModel: 'IS the lock infrastructure (proper-lockfile + sentinels)',
		crashBehavior: 'proper-lockfile stale recovery; orphaned .meta falls back to mtime expiry (:344-369)',
		closePolicy: 'untouched — deliberately excluded from close (src/commands/close/archive-stage.ts:423-424: "per-run locks are managed via proper-lockfile, not archived or cleaned by close")',
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy base64 lock paths honored (:82-94)',
		healthSignal: 'listActiveLocks output',
		owner: '#2035 (merged)',
		disposition: { kind: 'not-a-defect', proof: 'Per-run lock machinery with stale-timeout cleanup and deliberate close exclusion (src/parallel/file-locks.ts:7,250-297; src/commands/close/archive-stage.ts:423-424).' },
	},
	{
		id: 'task-evidence-trajectory',
		category: 3,
		pathGrammar: '.swarm/evidence/{taskId}/trajectory.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/trajectory-logger.ts'],
		writerCitations: [
			'src/hooks/trajectory-logger.ts:469 toolAfter — appendFile :555 then truncateTrajectoryFile :558 (also denied-call path :700-720)',
		],
		readerCitations: [
			'src/hooks/micro-reflector.ts:262 readTaskTrajectory — FULL-FILE, async, fail-open []',
			'src/consensus/corpus.ts:593 loadTaskTrajectories — via readTaskTrajectory per task',
		],
		schemaVersion: 'none',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'max_lines PER-FILE enforced at write time; truncation keeps newest floor(max_lines/2) (:114-133). NOTE (maintainer review #2395, finding on claim 7): the production knob is now `prm.max_trajectory_lines` (src/index.ts passes it to createTrajectoryLoggerHook and the denied-call path), previously a hardcoded 1000 — the writer CODE is unchanged but the evidence truncation budget is config-coupled; default 1000 is identical, so no default-config regression.',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER, not by key domain: one key per taskId directory, and taskId is only shape-validated (src/validation/task-id.ts:69-114 admits any /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ id, explicitly beyond plan task numbers), so the key domain is open. What bounds it is a GLOBAL deleter: ACTIVE_STATE_DIRS_TO_CLEAN contains "evidence" (src/commands/close/constants.ts:253-269) and the close clean loop runs fs.rm(dirPath, {recursive: true}) over the whole .swarm/evidence/ tree (src/commands/close/clean-stage.ts:176-190), dropping every key in one pass on a single session-lifecycle trigger. CAVEAT (verified, do not soften): the trigger is lifecycle-driven rather than size-driven and is archive-first-gated (src/commands/close/clean-stage.ts:176-185 skips the delete when the directory was not archived), and neither /swarm reset nor /swarm reset-session touches this tree — so a session that never closes accumulates one directory per distinct taskId.',
			citation: 'src/hooks/trajectory-logger.ts:114-133,466,558',
		},
		readBound: { pattern: 'full-file', bound: '≤500 lines per file by write-side truncation', sync: false, citation: 'src/hooks/trajectory-logger.ts:558 + micro-reflector.ts:262' },
		lockModel: 'none — single-line appends; per-line JSONL validity preserved',
		crashBehavior: 'torn tail tolerated by reader; truncation runs after append so newest entry is durable first',
		closePolicy: 'cleaned — evidence/ dir archived+cleaned (ACTIVE_STATE_DIRS_TO_CLEAN src/commands/close/constants.ts:256)',
		resetPolicy: 'reset-session does not touch evidence/',
		legacyCompatibility: 'reader skips malformed lines',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Already line-bounded at write (500/file, truncateTrajectoryFile production-called at trajectory-logger.ts:558/717) and close-scoped — the issue-directed "documented separately" row, distinct from the PRM session store owned by #2041.',
		},
	},
	{
		id: 'prm-session-trajectories',
		category: 3,
		pathGrammar:
			'.swarm/trajectories/{sessionId}.jsonl (+ {sessionId}.jsonl.meta.json checkpoint; transient {sessionId}.jsonl.lock and atomic-write *.tmp)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/prm/trajectory-store.ts'],
		writerCitations: [
			'src/prm/trajectory-store.ts appendTrajectoryEntry — locked appendFile with torn-tail re-framing; per-file .lock (wx existence lock — PID written for diagnostics only, never liveness-checked — 5-min stale-break, 20x5ms retry); append-time byte ceiling + every-25-appends line-count check both run bounded reverse compaction keeping the newest floor(maxLines/2) lines (issue #2041)',
		],
		readerCitations: [
			'src/prm/trajectory-store.ts readTrajectoryWithCoverage — TAIL-BOUNDED (readMaxBytes 1 MiB), coverage complete/truncated/empty + droppedByCompaction from the checkpoint (issue #2041)',
			'src/prm/trajectory-store.ts getCurrentStep — bounded step tail read (64 KiB) merged with the atomic checkpoint; restart-seeding caller src/hooks/trajectory-logger.ts ensureSessionStepSeeded',
			'src/prm/index.ts toolAfter cold start + src/consensus/corpus.ts loadPrmSessions — via the bounded readers; corpus flips ConsensusCorpus.truncated on partial windows',
		],
		schemaVersion: 'trajectory checkpoint v1 ({sessionId}.jsonl.meta.json)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'ONE knob prm.max_trajectory_lines (default 1000) governs cache trim AND disk compaction (newest floor(maxLines/2) retained); sovereign byte ceiling max(64 KiB, maxLines*512 B) enforced at APPEND time; oversize lines (>64 KiB) skipped; age sweep 7 d + per-directory count cap 200 .jsonl (256 unlinks/run) via cleanupOldTrajectoryFiles, scheduled once per PRM-active session (debounced 10 min) + one bounded post-resolution init pass',
			scope: 'per-key',
			keyspaceBound: 'GLOBAL reaper: cleanupOldTrajectoryFiles enforces maxFilesPerDir=200 .jsonl per directory (oldest-effective-mtime first, 256 unlinks/run, converging across runs — src/prm/trajectory-store.ts TRAJECTORY_LIMITS.maxFilesPerDir/maxDeletionsPerRun), so the session-file keyspace is finite at 200 keys/dir regardless of how many sessions the host mints; the age sweep reapes idle keys on the same global trigger',
			citation: 'src/prm/trajectory-store.ts TRAJECTORY_LIMITS + sessionMaxBytesFor (#2041 shipped)',
		},
		readBound: {
			pattern: 'tail-bounded-window',
			bound: 'readMaxBytes 1 MiB (step reads 64 KiB); never a whole-file read',
			sync: false,
			citation: 'src/prm/trajectory-store.ts readTrajectoryWithCoverage/getCurrentStep',
		},
		lockModel: 'per-file cross-process .lock (wx existence lock, no PID liveness check, stale-break, bounded retry) + in-process per-key promise chain; lock-exhaust skips the append with a warned, counted loss (trajectory_health append_skip)',
		crashBehavior: 'tmp+rename atomic publish; checkpoint written after the data rewrite under the same lock and ratchets max(prev, observed); the newest window always retains the max step; torn tails re-framed on append; corrupt lines shed and counted at compaction',
		closePolicy: 'untouched (bounded at write; age/count sweep owns reaping)',
		resetPolicy: 'resetPrmSessionState clears pointers, not files; step counters reseed from the checkpoint on next mint',
		legacyCompatibility: 'pre-#2041 unbounded files migrate on first compaction (bounded tail window); readers skip malformed/oversize lines',
		healthSignal: 'trajectory_health (trigger compaction/cleanup/append_skip; counts only)',
		owner: '#2041',
		disposition: {
			kind: 'retain-by-design',
			citation: 'Bounded at write by the #2041 shipped PR (append-time byte ceiling + check-interval line compaction); the retained window IS the PRM pattern-detection contract, mirrored by the in-memory cache trim rule.',
		},
	},
	{
		id: 'prm-replays',
		category: 3,
		pathGrammar: '.swarm/replays/{sessionId}-{timestamp}.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/prm/replay.ts'],
		writerCitations: ['src/prm/replay.ts recordReplayEntry — appendFile with a per-artifact 1 MiB byte cap (REPLAY_LIMITS, issue #2041): bytes tracked in memory, stat every 16 entries, skip + one-time warn at cap (startReplayRecording prepares the path, path-validated)'],
		readerCitations: ['write-only in production (tests/external tooling consume replays)'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'content',
		writeLimits: { bound: 'per-artifact 1 MiB byte cap at write (REPLAY_LIMITS, issue #2041): bytes tracked in memory, stat every 16 entries, skip + one-time warn at cap; shared age sweep 7 d + per-directory count cap 200 via cleanupOldTrajectoryFiles', scope: 'per-key', keyspaceBound: 'GLOBAL reaper: the same cleanupOldTrajectoryFiles sweep enforces maxFilesPerDir=200 .jsonl on .swarm/replays/ (oldest-first, 256 unlinks/run — src/prm/trajectory-store.ts TRAJECTORY_LIMITS), so the artifact keyspace is finite at 200 keys/dir regardless of session count', citation: 'src/prm/replay.ts REPLAY_LIMITS; trajectory-store.ts cleanupOldTrajectoryFiles (#2041 shipped)' },
		readBound: { pattern: 'write-only', bound: 'n/a', sync: false, citation: 'no production reader (verified)' },
		lockModel: 'none (single writer per artifact: one session instance owns the timestamped path; writes awaited sequentially per call site)',
		crashBehavior: 'append; torn tail harmless (no reader)',
		closePolicy: 'untouched (age/count sweep only)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a (cap skip is warned in logs; disclosed here)',
		owner: '#2041',
		disposition: {
			kind: 'retain-by-design',
			citation: 'Hard per-artifact byte cap shipped by the #2041 PR (issue #2041 Required 1 scopes replays into the PRM budget set); replays are write-only best-effort diagnostics.',
		},
	},
	{
		id: 'insight-candidates',
		category: 3,
		pathGrammar:
			'swarm.db table insight_candidate (issue #2480; legacy .swarm/insight-candidates.jsonl imported once then cold-archived .jsonl.imported)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/db/insight-candidate-store.ts',
			'src/hooks/micro-reflector.ts',
			'src/hooks/knowledge-curator.ts',
		],
		writerCitations: [
			'src/db/insight-candidate-store.ts appendInsightCandidatesDb — group-commit writer, one BEGIN IMMEDIATE txn per flush, MAX(version)+1 stream append, pending FIFO cap 500',
			'src/db/insight-candidate-store.ts consumeInsightCandidatesDb — dual-contract txn: SELECT pending batch + UPDATE consumed_at in one BEGIN IMMEDIATE; 7d consumed-row DELETE retention',
			'src/hooks/micro-reflector.ts appendInsightCandidates — delegates to the store (fail-open)',
			'src/hooks/knowledge-curator.ts consumeInsightCandidates — delegates to the store (fail-open, batch ≤ MESO_INSIGHT_BATCH_LIMIT)',
		],
		readerCitations: [
			'src/db/insight-candidate-store.ts countPendingInsightCandidatesDb — indexed COUNT over the pending partial index (status/diagnostics)',
			'src/db/insight-candidate-store.ts listPendingInsightCandidatesDb — bounded pending SELECT (postmortem raw-content surface)',
		],
		schemaVersion: 'append-only stream rows (payload JSON; identity recomputed from content — resolveInsightCandidateId)',
		stateClass: 'operational',
		privacyClass: 'content',
		writeLimits: {
			bound: 'INSIGHT_PENDING_CAP 500 GLOBAL FIFO on pending rows (insight-candidate-store.ts, DELETE-oldest inside the append txn) + 7-day DELETE retention on consumed rows',
			scope: 'global',
			citation: 'src/db/insight-candidate-store.ts',
		},
		readBound: { pattern: 'indexed', bound: 'pending partial index (stream_id, version) WHERE consumed_at IS NULL; batch ≤20/trigger', sync: true, citation: 'src/db/insight-candidate-store.ts consumeInsightCandidatesDb' },
		lockModel: 'SQLite WAL + busy_timeout 5000 + BEGIN IMMEDIATE write txns (append flush and consume txn); legacy import emptiness re-checked inside its txn',
		crashBehavior: 'WAL auto-recovery; unflushed queue ops are lost (crash backstop is the awaited flush, same durability as the legacy awaited file append); legacy import crash windows are idempotent',
		closePolicy: 'untouched (bounded queue inside swarm.db; swarm.db itself is archived+cleaned by the project-db row)',
		closeArrayMembership: {
			'insight-candidates.jsonl': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy .jsonl imported once (one-txn, table-empty guard) then renamed .jsonl.imported; corrupt lines skipped and counted; id recomputed from content',
		healthSignal: 'consumption counts',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Verified global 500-entry FIFO enforced on pending rows inside the append transaction plus 7-day consumed-row DELETE retention (src/db/insight-candidate-store.ts) — carried over from the legacy store and re-verified for the swarm.db migration (issue #2480).',
		},
	},
	{
		id: 'observability-events-sqlite',
		category: 3,
		pathGrammar:
			'swarm.db tables observability_event / observability_sink_health / observability_import (issue #2482; the bounded .swarm/telemetry.jsonl(.1) stream stays the operational legacy record, imported incrementally — never renamed)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/db/observability-event-store.ts'],
		writerCitations: [
			'src/db/observability-event-store.ts appendObservabilityEventDb — telemetry-listener sink; group-commit writer (one BEGIN IMMEDIATE txn per flush, durability class normal); INSERT OR IGNORE by event_id; throttled DELETE retention (MAX_OBSERVABILITY_EVENT_ROWS 50000) and health upsert ride the same batch',
			'src/db/observability-event-store.ts syncObservabilityImport — report-path-only incremental legacy import (fingerprint markers in observability_import, content-derived synthetic ids, INSERT OR IGNORE; one BEGIN IMMEDIATE per changed file)',
		],
		readerCitations: [
			'src/db/observability-event-store.ts queryObservabilityEvents — bounded deterministic SELECT (filters task/session/trace/batch/since; ORDER BY occurred_at,rowid; LIMIT MAX_REPORT_ROWS 5000)',
			'src/db/observability-event-store.ts readObservabilityCoverage / readObservabilitySinkHealth — coverage + health counters for /swarm report',
			'src/commands/report.ts handleReportCommand — the /swarm report consumer',
		],
		schemaVersion: 'envelope rows (eventId/kind/workflow ids/payload JSON; imported rows use sha256(obs-import-v1 + line) synthetic ids)',
		stateClass: 'operational',
		// ZB-review: the table persists raw payloads verbatim (incl. kinds the
		// event catalog labels 'sensitive'), so the honest class is 'content'.
		privacyClass: 'content',
		writeLimits: {
			bound: 'MAX_OBSERVABILITY_EVENT_ROWS 50000 GLOBAL DELETE-oldest (rowid ASC) inside the append batch every RETENTION_CHECK_INTERVAL 512 accepted events; per-payload cap MAX_EVENT_PAYLOAD_BYTES 16384 (oversize → quarantined truncated stub)',
			scope: 'global',
			citation: 'src/db/observability-event-store.ts',
		},
		readBound: { pattern: 'indexed', bound: 'idx_obs_event_* indexes; report queries LIMIT 5000 rows, quarantined rows excluded from timelines', sync: true, citation: 'src/db/observability-event-store.ts queryObservabilityEvents' },
		lockModel: 'SQLite WAL + busy_timeout 5000 + group-commit BEGIN IMMEDIATE batches (shared writer with the other swarm.db stores); legacy import runs its own BEGIN IMMEDIATE',
		crashBehavior: 'WAL auto-recovery; unflushed queue ops lost by design (fail-open observability — the telemetry.jsonl legacy line and the JSONL file remain the operational record); malformed events quarantined in-table with a reason, never dropped',
		closePolicy: 'untouched (bounded tables inside swarm.db; swarm.db itself is archived+cleaned by the project-db row)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'telemetry.jsonl(.1) NEVER renamed (it stays the live sink); syncObservabilityImport re-imports deterministically from per-file fingerprint markers — rotation/shrink triggers a content-deduped full rescan',
		healthSignal: 'observability_sink_health counters (accepted/quarantined/dropped/last_error)',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Global 50000-row DELETE-based retention + 16 KiB per-payload cap enforced inside the append batch (src/db/observability-event-store.ts runRetentionIfOverCap/buildLiveRow); rebuildable by construction — imported rows are content-derived and re-sync reproduces them (test-proven).',
		},
	},
	{
		id: 'postmortems',
		category: 3,
		pathGrammar: '.swarm/post-mortem-{planId}.md',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/curator-postmortem.ts'],
		writerCitations: ['src/hooks/curator-postmortem.ts:1100 runCuratorPostMortem — atomicWriteFile :1399, advisory lock, dedup'],
		readerCitations: ['src/hooks/curator-postmortem.ts:836 isReportValid — full read for validity, sync; /swarm status renders it'],
		schemaVersion: 'markdown report (legacy + structured action formats parsed :249,:400)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'one bounded-input report per plan (inputs capped :38-43); idempotent dedup',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: one key per planId (.swarm/post-mortem-{planId}.md). The GLOBAL deleter is a directory scan, not a per-plan hook — /swarm close readdirs .swarm/ and matches every /^post-mortem-[^/\\\\]+\\.md$/ name (src/commands/close/archive-stage.ts:351-375), copies each into the archive, records it in ctx.archivedActiveStateFiles, and then unlinks each matched artifact from .swarm/ (src/commands/close/clean-stage.ts:155-174). Because the sweep is driven by the directory listing rather than by a known set of plan ids, it reclaims keys the writer never told it about. CAVEAT: the unlink runs only for artifacts that archived successfully — src/commands/close/clean-stage.ts:45-79 deliberately preserves active state when nothing was archived — and the trigger is session close, so an unclosed session retains one report per plan.',
			citation: 'src/hooks/curator-postmortem.ts:38-43,1129-1137',
		},
		readBound: { pattern: 'full-file', bound: 'single report per plan', sync: true, citation: 'src/hooks/curator-postmortem.ts:819' },
		lockModel: 'tryAcquireLock non-blocking, skip if held (:836-846,1145-1156)',
		crashBehavior: 'atomic write; invalid report regenerated next run',
		closePolicy: 'archived+cleaned — dynamic artifacts (src/commands/close/archive-stage.ts:351-375; src/commands/close/clean-stage.ts:155-174)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'parseLegacyPostMortemActions + structured parser both tried (:249,:400,:475-490)',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Per-plan idempotent artifact with capped inputs, archived+cleaned at finalize (src/hooks/curator-postmortem.ts:1129-1137; close.ts dynamic artifact sweep).' },
	},
	{
		id: 'epic-promotions-evidence',
		category: 3,
		pathGrammar: '.swarm/evidence/epic-promotions.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/turbo/epic/promotion-evidence.ts'],
		writerCitations: ['src/turbo/epic/promotion-evidence.ts:44 appendPromotionEvidence — appendFileSync :61, no cap'],
		readerCitations: ['src/turbo/epic/promotion-evidence.ts:70 readPromotionEvidence — FULL-FILE readFileSync, sync (/swarm epic status)'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'no per-file cap; bounded by session — evidence/ dir archived+cleaned at close (src/commands/close/constants.ts:256)', scope: 'session-scoped', citation: 'src/turbo/epic/promotion-evidence.ts:61; src/commands/close/constants.ts:253-269' },
		readBound: { pattern: 'full-file', bound: 'session-scoped file (close-cleaned)', sync: true, citation: 'src/turbo/epic/promotion-evidence.ts:70-88' },
		lockModel: 'none — single-line appends',
		crashBehavior: 'torn tail skipped by reader',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Batch/session-scoped artifact: one line per phase decision, whole directory archived+cleaned at close — reader cost bounded by session length (close.ts ACTIVE_STATE_DIRS_TO_CLEAN).' },
	},
	{
		id: 'knowledge-promotion-evidence',
		category: 3,
		pathGrammar: '.swarm/knowledge-promotion-evidence.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/promotion-evidence-store.ts'],
		writerCitations: ['src/hooks/promotion-evidence-store.ts:73 appendPromotionEvidence — appendFile + trimIfOversized FIFO'],
		readerCitations: ['src/hooks/promotion-evidence-store.ts:123 loadPromotionEvidenceByEntry — reads the RECEIPT LEDGER, not this file (derived projection)'],
		schemaVersion: 'none',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'MAX_PROMOTION_EVIDENCE_ENTRIES 2000 GLOBAL FIFO (:41,92-105)', scope: 'global', citation: 'src/hooks/promotion-evidence-store.ts:41,92-105' },
		readBound: { pattern: 'indexed', bound: 'authoritative reader queries the receipt ledger (bounded per receipts-v2 row)', sync: false, citation: 'src/hooks/promotion-evidence-store.ts:123-167' },
		lockModel: 'none on the projection (authority lives in the locked receipt ledger)',
		crashBehavior: 'append + atomic FIFO trim (temp+rename :103-104); fail-open',
		closePolicy: 'untouched (derived, bounded)',
		closeArrayMembership: {
			'knowledge-promotion-evidence.jsonl': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Verified 2000-entry global FIFO AND derived-from-authority reader (receipt ledger) — the issue-directed verify-before-retain check for "promotion evidence" passed (src/hooks/promotion-evidence-store.ts:41,113).',
		},
	},
	{
		id: 'epic-turbo-state',
		category: 3,
		pathGrammar: '.swarm/epic-state.json + .swarm/epic/{calibration.json,divergence.jsonl,coupling-report.json} + .swarm/turbo-state.json + .swarm/recovery/{session-lane}.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/turbo/epic/state.ts',
			'src/turbo/epic/calibration.ts',
			'src/turbo/epic/divergence-recorder.ts',
			'src/turbo/lean/state.ts',
			'src/turbo/lean/recovery.ts',
			'src/commands/coupling.ts',
		],
		writerCitations: [
			'src/turbo/epic/state.ts:519 saveEpicSessionState — per-session SQLite CAS with post-commit JSON projection',
			'src/turbo/epic/calibration.ts:219 saveCalibrationState — hotModuleAdditions truncated to MAX_CALIBRATION_MODULES 500 (lexicographically smallest prefix, enforced on save AND load, :70,:74-79)',
			'src/turbo/epic/divergence-recorder.ts:176 recordTaskDivergence — append + write-side compaction enforcing MAX_DIVERGENCE_BYTES 8 MiB (whole-record floor, :64,:76-77)',
			'src/turbo/lean/state.ts:601 saveLeanTurboRunState — per-session SQLite CAS; src/turbo/lean/recovery.ts:163 writeRecoveryRecord (cleared on merge-back :214-227)',
			'src/commands/coupling.ts:153 persistReportJson (--persist only, single rewritten file)',
		],
		readerCitations: [
			'src/turbo/epic/state.ts:508 loadEpicSessionState — indexed SQLite state row',
			'src/turbo/epic/calibration.ts:170 loadCalibrationState — FULL-FILE (cap enforced on load too, :206-209)',
			'src/turbo/epic/divergence-recorder.ts:264 readDivergenceHistory — TAIL-BOUNDED 16 MiB (MAX_TAIL_BYTES :247), sync',
			'src/turbo/lean/recovery.ts:191 listRecoveryRecords — directory scan',
		],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_CALIBRATION_MODULES 500 truncation on every save AND load (src/turbo/epic/calibration.ts:70,74-79); MAX_DIVERGENCE_BYTES 8 MiB write-side compaction with whole-record floor (src/turbo/epic/divergence-recorder.ts:64,76-77); retention sweep deletes epic/calibration.json + epic/divergence.jsonl whole-file at 30 d (src/retention/sweep.ts:169); close archives+cleans epic-state.json + turbo-state.json (src/commands/close/constants.ts:53-54; src/commands/close/constants.ts:187-190) and the runs/ + epic/ dirs (src/commands/close/constants.ts:267-268)',
			scope: 'global',
			citation: 'src/turbo/epic/calibration.ts:70; src/turbo/epic/divergence-recorder.ts:64; src/retention/sweep.ts:169; src/commands/close/constants.ts:253-269',
		},
		readBound: { pattern: 'mixed full-file + tail', bound: 'divergence reader tail-bounded 16 MiB (MAX_TAIL_BYTES); calibration reader full-file but the state is cap-truncated on load', sync: true, citation: 'src/turbo/epic/divergence-recorder.ts:247,264' },
		lockModel: 'SQLite BEGIN IMMEDIATE + revision/generation CAS for session state; recovery records cleared on successful merge-back',
		crashBehavior: 'atomic rewrites with fail-closed corrupt markers and repair paths',
		closePolicy: 'archived+cleaned — epic-state.json + turbo-state.json in both arrays (src/commands/close/constants.ts:53-54; src/commands/close/constants.ts:187-190); runs/ + epic/ dirs archived+cleaned (ACTIVE_STATE_DIRS_TO_CLEAN src/commands/close/constants.ts:267-268); recovery/ stays out of close — the 30 d sweep owns it (src/retention/sweep.ts:102)',
		closeArrayMembership: {
			'epic-state.json': 'archive+clean',
			'turbo-state.json': 'archive+clean',
		},
		resetPolicy: 'per-session reset functions only (resetEpicSession :309, resetLeanTurboRun :340)',
		legacyCompatibility: 'seed-empty on first read',
		healthSignal: 'fail-closed unreadable markers',
		owner: '#2481 (session maps); #2483 (calibration/divergence bounds + close/sweep lifecycle)',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Every member is bounded: calibration MAX_CALIBRATION_MODULES 500 truncation on save AND load (src/turbo/epic/calibration.ts:70,74-79), divergence MAX_DIVERGENCE_BYTES 8 MiB write-side compaction (src/turbo/epic/divergence-recorder.ts:64,76-77), the retention sweep\'s 30 d whole-file delete for both epic diagnostics (src/retention/sweep.ts:169), and the #2483 close wiring (epic-state.json + turbo-state.json archive+clean, src/commands/close/constants.ts:53-54; src/commands/close/constants.ts:187-190; runs/ + epic/ dirs, src/commands/close/constants.ts:267-268).',
		},
	},
	{
		id: 'lean-turbo-evidence',
		category: 3,
		pathGrammar: '.swarm/evidence/{phase}/lean-turbo/{laneId}.json + lean-turbo-phase.json + lean-turbo-critic.json + lean-turbo-reviewer.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/turbo/lean/evidence.ts', 'src/turbo/lean/integration.ts', 'src/turbo/lean/reviewer.ts'],
		writerCitations: [
			'src/turbo/lean/evidence.ts:216 writeLaneEvidence / :269 writePhaseEvidence — atomic',
			'src/turbo/lean/integration.ts:404 writeCriticEvidence / src/turbo/lean/reviewer.ts:381 writeReviewerEvidence — atomic',
		],
		readerCitations: ['src/turbo/lean/evidence.ts:234,284,320 — per-file + directory listing, sync; integration.ts:249 compileCriticPackage'],
		schemaVersion: 'none',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'per-phase/per-lane artifacts; evidence/ dir archived+cleaned at close', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:253-269' },
		readBound: { pattern: 'indexed', bound: 'session-scoped evidence dir', sync: true, citation: 'src/turbo/lean/evidence.ts:234-341' },
		lockModel: 'none explicit; atomic temp+rename per file with cache invalidation',
		crashBehavior: 'atomic; ENOENT → null',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Batch-scoped per-phase/per-lane artifacts under the close-cleaned evidence/ directory (close.ts ACTIVE_STATE_DIRS_TO_CLEAN).' },
	},
	{
		id: 'evidence-gate-artifacts',
		category: 3,
		pathGrammar: '.swarm/evidence/{phase}/{drift-verifier,hallucination-guard,mutation-gate,req-coverage-phase-N,completion-verify,full-auto-N}.json + evidence/sbom/sbom-{ts}.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/tools/write-drift-evidence.ts',
			'src/tools/write-hallucination-evidence.ts',
			'src/tools/write-mutation-evidence.ts',
			'src/tools/req-coverage.ts',
			'src/tools/completion-verify.ts',
			'src/tools/sbom-generate.ts',
			'src/full-auto/oversight.ts',
			'src/agents/index.ts',
		],
		writerCitations: [
			'src/tools/write-drift-evidence.ts:275 / write-hallucination-evidence.ts:121 / write-mutation-evidence.ts:169 — atomic single JSONs',
			'src/tools/req-coverage.ts:557 — writeFileSync overwrite per phase',
			'src/tools/completion-verify.ts:486 — writeFileSync per phase',
			'src/tools/sbom-generate.ts:383 — timestamped per-run BOM (accumulates within session)',
			'src/full-auto/oversight.ts:279 — evidence/{phase}/full-auto-{seq}.json',
		],
		readerCitations: ['gate readers (check_gate_status, phase-complete gates/mutation-gate.ts) — per-file reads'],
		schemaVersion: 'per-artifact Zod schemas (bounded fields, e.g. findings ≤4000 chars)',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: { bound: 'per-phase overwrite or bounded per-run artifacts; whole tree archived+cleaned at close', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:253-269; write-hallucination-evidence.ts:34' },
		readBound: { pattern: 'indexed', bound: 'single small JSON per gate', sync: true, citation: 'src/tools/phase-complete/gates/mutation-gate.ts' },
		lockModel: 'atomic temp+rename (no lock — single-writer tools)',
		crashBehavior: 'atomic; old file preserved on failed rename',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'gate pass/fail states',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Batch-scoped gate artifacts (per-phase overwrite or per-run) under the close-cleaned evidence/ directory; sbom timestamped accumulation is bounded by session scope.' },
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 4 — guardrail audit, attestations, scope evidence
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'shell-audit',
		category: 4,
		pathGrammar: '.swarm/session/shell-audit.jsonl (+ transient .lock)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/hooks/guardrails/shell-audit-store.ts',
			'src/hooks/guardrails/audit-log.ts',
		],
		writerCitations: [
			'src/hooks/guardrails/audit-log.ts appendGuardrailDecision — the single validated+redacted decision seam (issue #2040); seven fire-and-forget call sites, all in src/hooks/guardrails/tool-before.ts; line-shaping truncates commands (4,096 chars) and redacts before persisting',
			'src/hooks/guardrails/shell-audit-store.ts appendShellAuditLineSync — per-write exclusive .swarm/session/shell-audit.lock (wx, 5-min stale-break), torn-tail re-framing, decision-class priority compaction',
		],
		readerCitations: [
			'src/hooks/guardrails/shell-audit-store.ts readShellAuditTail — tail-bounded (readMaxBytes 256 KiB), manifest-stripped, coverage complete/truncated/empty',
			'src/hooks/guardrails/shell-audit-store.ts getShellAuditFoldedSummary — header-only folded aggregate read',
			'src/services/guardrail-log-service.ts handleGuardrailLog — /swarm guardrail-log renders the bounded window (≤200 entries) with render-time re-redaction of legacy records through the CURRENT policy',
		],
		schemaVersion: 'v1 swarm-shell-audit-manifest header + retained window (issue #2040); legacy 5-field shell lines preserved byte-for-byte; typed command entries carry a 16-hex commandHash (sha256 of the redacted command, never rendered)',
		stateClass: 'operational',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'SHELL_AUDIT_LIMITS: activeMaxBytes 1 MiB (manifest+window, sovereign over both classes), securityMaxEntries 4,000 (typed decisions — never age-folded), allowedMaxEntries 2,000 + allowedAgeMaxMs 72 h (legacy allowed shell decisions), compactMaxBytes 256 KiB/pass, checkInterval 25, maxLineBytes 64 KiB (commands truncated to 4,096 chars at line-shaping time)',
			scope: 'global',
			citation: 'src/hooks/guardrails/shell-audit-store.ts SHELL_AUDIT_LIMITS (issue #2040)',
		},
		readBound: {
			pattern: 'manifest+retained-window (tail-bounded)',
			bound: 'readMaxBytes 256 KiB independent of total history; render capped at 200 entries with explicit truncation footer',
			sync: true,
			citation: 'src/hooks/guardrails/shell-audit-store.ts readShellAuditTail; src/services/guardrail-log-service.ts MAX_RENDERED_ENTRIES',
		},
		lockModel: 'exclusive .swarm/session/shell-audit.lock (wx create, 5-min mtime stale-break, bounded brief retry) held by EVERY write — appends, compaction, finalize',
		crashBehavior: 'atomic single-file rewrites (PID-scoped tmp + byte-verified rename; in-memory manifest/framing validation pre-rename); torn trailing line skipped + counted corrupt, re-framed on next append; legacy header-less files migrate in bounded fold passes',
		closePolicy: 'finalizeShellAuditForClose under the store lock (legacy drain to convergence + compaction + validated cut + ARCHIVE-TIME RE-REDACTION of retained lines through the current policy via redactDecisionLineForArchive) BEFORE the plain session/ directory archive copy, then archived (via the session dir copy) and cleaned (session dir lifecycle); the lock file is released (unlinked) by finalize so a stale lock is never archived',
		resetPolicy: '/swarm reset does not touch .swarm/session (state.json parity); /swarm reset-session deletes shell-audit.jsonl with the other session files (state.json excepted)',
		legacyCompatibility: 'header-less files read bounded (newest window); legacy records re-redact at BOTH boundaries through the CURRENT policy — render time (redactShellCommand/redactPath in guardrail-log-service) and archive time (redactDecisionLineForArchive in the close finalize) — so no legacy record bypasses current policy; the live fold pass preserves lines byte-for-byte (only the archived cut re-redacts)',
		healthSignal: 'shell_audit_health (counts-only: accepted/compacted/retained/dropped/corrupt + oldest/newest timestamps + bytes/limit_bytes)',
		owner: '#2040',
		disposition: {
			kind: 'retain-by-design',
			issue: 2040,
			citation:
				'PR 12 shipped the bounded single-file security-audit store (src/hooks/guardrails/shell-audit-store.ts manifest header + retained window under SHELL_AUDIT_LIMITS) with decision-class priority (security transitions never age out; allowed decisions 72 h / 2,000-cap), tail-bounded reads replacing the whole-file guardrail-log read, strengthened caller-independent write-time redaction plus render-time re-redaction, a validated close cut, the shell_audit_health counts-only signal, and the check:shell-audit usage ratchet; verified by tests/unit/hooks/shell-audit-*.test.ts and tests/unit/services/guardrail-log-service-bounded.test.ts.',
			note: 'Guardrail authorization is computed independently of every audit write (fail-open fire-and-forget appends) — retention and sampling can never alter a block/allow decision.',
		},
	},
	{
		id: 'attestations',
		category: 4,
		pathGrammar: '.swarm/evidence/attestations.jsonl (+ attestation_rejected events in events.jsonl)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/guardrails/file-authority.ts'],
		writerCitations: ['src/hooks/guardrails/file-authority.ts:123 recordAttestation — appendFile :130; :136 validateAndRecordAttestation (rejections → events.jsonl :156)'],
		readerCitations: ['write-only in production (no reader found — audit trail)'],
		schemaVersion: 'none',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: { bound: 'one line per attestation decision; evidence/ dir archived+cleaned at close', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:253-269' },
		readBound: { pattern: 'write-only', bound: 'n/a', sync: false, citation: 'no production reader (verified)' },
		lockModel: 'none',
		crashBehavior: 'append propagates errors to caller; torn tail unobserved (no reader)',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Session-scoped audit append under the close-cleaned evidence/ directory; no reader amplification exists.' },
	},
	{
		id: 'scopes-family',
		category: 4,
		pathGrammar: '.swarm/scopes/{scope-{taskId}.json, binding-*.json, *.generation-lock, *.retirement-intent, claim-{digest}.json}',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/scope/scope-persistence.ts'],
		writerCitations: [
			'src/scope/scope-persistence.ts:1241 writeScopeToDisk (v1 projection) / :1317 writeScopeBindingToDisk (v2) / :1833 claimScopeBindingForChildDurably / :2057 replaceExistingScopeDeclaration / :1693 tombstoneScopeBinding / :1756 refreshScopeBindingLease / :480 transitionScopeBindingState / :603 importScopeBindingStateRows',
		],
		readerCitations: [
			'src/scope/scope-persistence.ts:2712 readScopeFromDisk — bounded 2 MiB O_NOFOLLOW v1 compatibility, sync',
			'src/scope/scope-persistence.ts:899 readAllAuthoritativeScopeBindings — bounded indexed SQLite scan, sync',
		],
		schemaVersion: 'v1 projection + v2 exact-generation bindings (v1 never authorizes: :916)',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Write-authorization scope bindings are read on every coder write preflight and must answer fail-closed with no DB handle dependency; the bounded constant set (10k files / 2 MiB / 256 tombstones / 7 d TTL) is the durability bound and clearAllScopes at close is the lifecycle.',
			reviewedIssue: 2036,
		},
		writeLimits: {
			bound: 'MAX_FILES_PER_SCOPE 10k (:87); MAX_SCOPE_BYTES 2 MiB (:89); MAX_BINDING_FILES_TO_SCAN 10k (:90); tombstones ≤256 / 7-day TTL (:91-92, scope-binding.ts:14-16); pending ≤256',
			scope: 'global',
			citation: 'src/scope/scope-persistence.ts:87-92',
		},
		readBound: { pattern: 'directory-scan', bound: '≤10k files scanned, ≤2 MiB per scope read', sync: true, citation: 'src/scope/scope-persistence.ts:1345-1411,2534' },
		lockModel: 'proper-lockfile per binding with generation-lock sidecars (:347,:848-852); bounded sync retry (:112-129)',
		crashBehavior: 'atomic writes; v1 write silent-no-op, v2 returns typed failures with rollback (:902-913)',
		closePolicy: 'cleaned-only — clearAllScopes rmSync, NOT archived ("scope files are ephemeral state", src/commands/close/clean-stage.ts:358-362)',
		resetPolicy: 'reset-session does not clear scopes (close does)',
		legacyCompatibility: 'v1 disk + plan.json + pending-map fallback chain (:2655)',
		healthSignal: 'typed persistence results',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Fully bounded constant set (10k/2 MiB/256/7d) with per-binding locks and deliberate ephemeral close cleanup (src/scope/scope-persistence.ts:87-92; src/commands/close/clean-stage.ts:358-362).' },
	},
	{
		id: 'task-workflow-evidence',
		category: 4,
		pathGrammar: '.swarm/evidence/{taskId}.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/gate-evidence.ts', 'src/council/council-evidence-writer.ts'],
		writerCitations: [
			'src/gate-evidence.ts:879 transitionTaskWorkflowEvidence / :956 recordGateEvidence / :1010 recordAgentDispatch — locked read-modify-write, atomic write',
			'src/council/council-evidence-writer.ts:96 writeCouncilEvidence — gates.council section under withTaskEvidenceLock',
		],
		readerCitations: [
			'src/gate-evidence.ts:1054 readTaskEvidence — FULL-FILE fail-open, async; :1071 readTaskEvidenceRaw — strict, sync',
			'src/council/council-evidence-writer.ts:207 hasCouncilEvidenceAttempt',
		],
		schemaVersion: 'workflow WAL states; unrecognized states degrade to null (documented :1048-1052)',
		stateClass: 'authoritative',
		privacyClass: 'mixed',
		directFileExemption: {
			reason: 'The per-task workflow WAL gates phase transitions and must be readable during recovery before any DB handle is warmed; retryHistory ≤3 and the close-cleaned evidence/ tree bound the direct files.',
			reviewedIssue: 2036,
		},
		writeLimits: {
			bound: 'retryHistory ≤3 (schema :303); per-task file; evidence/ archived+cleaned at close',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER, not by key domain: one key per taskId — a flat .swarm/evidence/{taskId}.json (src/gate-evidence.ts:764 getEvidencePath) whose taskId is only shape-validated (src/validation/task-id.ts:69-114), so the domain is open. The GLOBAL deleter is the same one the task-evidence-trajectory row cites: "evidence" is in ACTIVE_STATE_DIRS_TO_CLEAN (src/commands/close/constants.ts:253-269) and the close clean loop recursively removes the whole tree (src/commands/close/clean-stage.ts:176-190), taking every {taskId}.json with it. Note the per-file retryHistory ≤3 cap is NOT the keyspace bound — it caps one key\'s history and says nothing about how many keys exist. CAVEAT: archive-first-gated (src/commands/close/clean-stage.ts:176-185) and untouched by /swarm reset and /swarm reset-session, so an unclosed session holds one file per distinct taskId.',
			citation: 'src/gate-evidence.ts:303; src/commands/close/constants.ts:253-269 ACTIVE_STATE_DIRS_TO_CLEAN',
		},
		readBound: { pattern: 'full-file', bound: 'single per-task JSON', sync: true, citation: 'src/gate-evidence.ts:1054-1089' },
		lockModel: 'withTaskEvidenceLock (evidence/{taskId}.json key) — proper-lockfile, 60 s timeout, backoff+jitter',
		crashBehavior: 'atomic write; WAL PREPARED fencing (assertTaskEvidenceWriteAllowed :117)',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'unknown workflow states read as null (graceful degrade)',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Per-task bounded artifact (retryHistory ≤3) under evidence lock with atomic writes and close-scoped lifecycle.' },
	},
	{
		id: 'evaluation-store',
		category: 4,
		pathGrammar: '.swarm/evolution/** (gate-audit/{runId}/, runs/, decisions/, task-sets/, tasks/, split-registry.json, test-consumption.jsonl, consensus/{reportId}.json, skills/**)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/evaluation/store.ts',
			'src/evaluation/gate-ground-truth.ts',
			'src/evaluation/gate-audit.ts',
			'src/evaluation/runner.ts',
			'src/consensus/store.ts',
			'src/services/skill-optimizer/store.ts',
			'src/services/skill-optimizer/controller.ts',
		],
		writerCitations: [
			'src/evaluation/store.ts:421/442/324/365/396/186 — write-once immutable artifacts (writeImmutable, EvaluationConflictError on divergence); :546 claimHeldOutTest appends test-consumption ledger',
			'src/evaluation/gate-ground-truth.ts:75 saveGateGroundTruth — idempotent merge append',
			'src/consensus/store.ts:109 writeConsensusReport — immutable + integrity hash; :287 pruneConsensusReports (config retention)',
			'skill-optimizer store/controller — see skill-optimizer-evolution row (subset listed here for module coverage)',
		],
		readerCitations: [
			'src/evaluation/store.ts:492 listGateAuditResults — directory scan + per-file reads',
			'src/consensus/store.ts:183 listConsensusReports — ≤1000 listed (:46), corrupt reported not fatal',
			'src/evaluation/gate-ground-truth.ts:144 readGateGroundTruth — full-file per run',
		],
		schemaVersion: 'per-artifact schemas; immutable identity = content',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'immutable write-once (no rewrite, divergent rewrite throws); consensus retention config-driven; list enumerations capped (1000 reports, 2000 corpus entries); test-consumption ledger append-only by integrity requirement',
			scope: 'global',
			citation: 'src/evaluation/store.ts:145-198; src/consensus/store.ts:46,287-319; docs/evaluation-substrate.md (immutable held-out integrity)',
		},
		readBound: { pattern: 'directory-scan', bound: 'enumeration caps (1000/2000); per-artifact full reads', sync: false, citation: 'src/consensus/store.ts:46,203; src/consensus/corpus.ts:265,366,393' },
		lockModel: 'withEvidenceLock via writeImmutableArtifact; consensus actor consensus-store',
		crashBehavior: 'write-once + idempotent merges; integrity hash re-verified on read (ConsensusIntegrityError on tamper)',
		closePolicy: 'untouched — evolution/ is in no close clean list (held-out-test integrity survives sessions by design)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'corrupt artifact reporting (corruptReportIds)',
		owner: 'this-gate',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'docs/evaluation-substrate.md — evaluation artifacts are immutable held-out-test integrity data; the test-consumption ledger MUST persist to prevent held-out reuse; write-once semantics + integrity hashes + enumeration caps + config-driven consensus retention are the bounded-reader/close proof.',
		},
	},
	{
		id: 'harness-evolution-store',
		category: 4,
		pathGrammar:
			'.swarm/evolution/harness/{current.json,candidates/{candidateId}/**,versions/{versionId}.json,ledger/{active-generation.json,generation-*/NNNNNN.jsonl}}',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/harness/store.ts'],
		writerCitations: [
			'src/harness/store.ts recordHarnessCandidate / activateHarnessCandidate / rollbackHarnessVersion — locked immutable artifact writes followed by an authenticated ledger commit',
			'src/harness/store.ts reconcileHarnessPhysicalRetentionUnderLock — generation-switch compaction followed by candidate and inactive-ledger pruning',
		],
		readerCitations: [
			'src/harness/store.ts loadHarnessCurrent — pointer-fast read or replay bounded by max_replay_records',
			'src/harness/store.ts loadHarnessHistory / auditHarnessLedger — newest-first bounded history and explicit segment/replay-bounded audit',
		],
		schemaVersion: 'v1 strict candidate/version/current records + hash-chained ledger records; compacted records authenticate the retained state and candidate bindings',
		stateClass: 'authoritative',
		privacyClass: 'mixed',
		directFileExemption: {
			reason: 'Hash-chained activation/rollback ledger whose integrity property — compacted records authenticate the retained state — is the #1825 durability contract; physical retention is globally bounded (version/candidate caps + generation-switch ledger compaction).',
			reviewedIssue: 1825,
		},
		writeLimits: {
			bound:
				'max_versions defaults to 100; max_inactive_candidates defaults to 32 (plus the newest activation handoff); candidate records are individually capped at 8 MiB; ledger segments are capped at 256 KiB and compact to one authenticated snapshot generation when max_replay_records is exceeded, with stale generations pruned after the pointer switch',
			scope: 'global',
			citation:
				'src/harness/store.ts MAX_CANDIDATE_ARTIFACT_BYTES, LEDGER_SEGMENT_MAX_BYTES, reconcileHarnessPhysicalRetentionUnderLock; src/config/schema.ts HarnessEvolutionConfigSchema',
		},
		readBound: {
			pattern: 'indexed + line-bounded',
			bound:
				'current and immutable artifacts are single-file reads; ledger replay is capped by max_replay_records (default 10,000), history has an explicit result limit, and audit is bounded by both maxSegments and maxReplayRecords',
			sync: true,
			citation:
				'src/harness/store.ts loadCurrentProjectionFast, readVerifiedLedgerRecords, loadHarnessHistory, auditHarnessLedger',
		},
		lockModel:
			'proper-lockfile on the harness root serializes every mutation, recovery, compaction pointer switch, and post-commit prune',
		crashBehavior:
			'fsynced append is the ordinary commit point; torn final lines are explicitly recoverable; compaction writes and verifies a new immutable generation before atomically switching active-generation.json, and only then best-effort prunes the old generation',
		closePolicy:
			'untouched — harness versions intentionally survive sessions as the durable activation and rollback substrate',
		resetPolicy: 'not reset',
		legacyCompatibility:
			'pre-compaction flat ledger segments remain readable until the first bounded compaction; absent compacted-record fields default to their v1 empty values',
		healthSignal:
			'mutation results report projection, artifact-prune, and physical-retention reconciliation failures separately; integrity and replay-bound failures are typed',
		owner: '#1825',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Issue #1825 requires one durable store for activation and rollback. Physical storage is globally bounded by retained version/candidate caps plus generation-switch ledger compaction, while all replay and query paths have independent record/segment/output bounds; adversarial coverage lives in tests/unit/harness/store-retention.test.ts and store-replay-bounds.test.ts.',
		},
	},
	{
		id: 'task-gate-evidence',
		category: 4,
		pathGrammar: '.swarm/evidence/task-gate-requirements/{taskId}.jsonl (+ repaired task-gate evidence files + task-gate-quarantine/ sidecars)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/evidence/task-gate-repair.ts', 'src/evidence/task-gate-requirements.ts'],
		writerCitations: [
			'src/evidence/task-gate-requirements.ts:271 appendTaskGateRequirementsReceiptIfNeeded via atomicWriteFile (schemaVersion 1 records); :282 read-back before append',
			'src/evidence/task-gate-repair.ts:496 fileHandle.writeFile repaired evidence under withTaskEvidenceLock; :955 atomicWriteFile; quarantine moves into task-gate-quarantine/ (:29-31)',
		],
		readerCitations: [
			'src/evidence/task-gate-requirements.ts:181 readTaskGateRequirementsReceipts — bounded read (256 KiB cap enforced :149-175), async',
			'src/tools/repair-gate-evidence.ts + src/gate-evidence.ts consumers of the repaired evidence',
		],
		schemaVersion: 'schemaVersion 1 (z.literal(1), task-gate-requirements.ts:17)',
		stateClass: 'authoritative',
		privacyClass: 'mixed',
		directFileExemption: {
			reason: 'Task-gate requirement receipts and repair quarantine preserve pre-repair originals as evidence under the evidence lock; per-task 256 KiB hard caps plus the shared quarantine admission cap (32 files / 12 MiB global, enforced by refusal) bound the direct files.',
			reviewedIssue: 2036,
		},
		writeLimits: {
			bound: 'MAX_TASK_GATE_REQUIREMENTS_BYTES 256 KiB per task file (:13, hard-fails OVERSIZED); repaired evidence MAX_TASK_GATE_EVIDENCE_BYTES 256 KiB (:33); quarantine caps 32 files / 12 MiB / 128 entries / 768 KiB per record (:34-37)',
			scope: 'per-key',
			keyspaceBound:
				'Two sub-streams, each finite for a different reason. (1) Requirements files, one key per taskId at .swarm/evidence/task-gate-requirements/{taskId}.jsonl (src/evidence/task-gate-requirements.ts:44) — a true SUBPATH of .swarm/evidence/, so the close-time recursive removal of the whole evidence tree (ACTIVE_STATE_DIRS_TO_CLEAN contains "evidence", src/commands/close/constants.ts:253-269; fs.rm recursive at src/commands/close/clean-stage.ts:176-190) is a global deleter over this keyspace too. (2) Quarantine sidecars carry a genuine GLOBAL count cap independent of the close lifecycle: TASK_GATE_EVIDENCE_QUARANTINE_DIR is a single shared directory with NO {taskId} path component (src/evidence/task-gate-repair.ts:29-32), and the admission check opendirs it and sums count/bytes across ALL tasks before admitting a write (src/evidence/task-gate-repair.ts:448-480), so total quarantine files can never exceed 32 / 12 MiB however many taskIds appear. CAVEAT: cap (2) bounds by REFUSAL, not eviction — at the ceiling it throws TASK_GATE_EVIDENCE_QUARANTINE_FULL and admits nothing new rather than making room; and sub-stream (1) inherits the evidence-tree caveat (archive-first-gated, untouched by /swarm reset and /swarm reset-session).',
			citation: 'src/evidence/task-gate-requirements.ts:13,149-175; src/evidence/task-gate-repair.ts:33-37',
		},
		readBound: { pattern: 'line-bounded', bound: 'reads reject files over 256 KiB (typed error)', sync: false, citation: 'src/evidence/task-gate-requirements.ts:149-175' },
		lockModel: 'withTaskEvidenceLock (same evidence/{taskId} key domain as the task-workflow-evidence row)',
		crashBehavior: 'atomic writes (atomicWriteFile / fsynced fileHandle.write); torn repair quarantined with digest',
		closePolicy: 'cleaned — evidence/ dir archived+cleaned at close',
		resetPolicy: 'not reset',
		legacyCompatibility: 'quarantine sidecars preserve pre-repair originals',
		healthSignal: 'quarantine counts',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof: 'Per-task hard byte caps (256 KiB each, typed OVERSIZED errors), locked atomic writes, bounded quarantine sidecars, and the close-cleaned evidence/ directory lifecycle (registered 2026-08-23 when the task-gate-repair work merged from main (#2301 family) introduced the writers).',
		},
	},

	{
		id: 'sast-baseline',
		category: 4,
		pathGrammar: '.swarm/evidence/{phase}/sast-baseline.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/tools/sast-baseline.ts'],
		writerCitations: ['src/tools/sast-baseline.ts:483 captureOrMergeBaseline — temp+rename :754-759,813-818; full prune of rescanned fingerprints :569-585'],
		readerCitations: ['src/tools/sast-baseline.ts:846 loadBaseline — full-file readFileSync :866, typed result, sync'],
		schemaVersion:
			'baseline schema 1.1.0 (truncation-aware; #2302 added reflow_keys[] + triage_log[] audit fields — a 1.0.0 file has no reflow_keys because they cannot be reconstructed after capture, loads exact-only, and upgrades to 1.1.0 at its next capture)',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_BASELINE_FINDINGS 2000 (:65); MAX_BASELINE_BYTES 2 MiB (:68) with truncation :690-712,777-795',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER ONLY — the key domain is open. `phase` is a positive integer with no upper limit: the tool schema is z.number().int().min(1) with no .max() (src/tools/sast-scan.ts:969-976, duplicated at src/tools/pre-check-batch.ts:1677-1684), validatePhase rejects only phase < 1 (src/tools/sast-baseline.ts:447-452), and PlanSchema.phases is z.array(PhaseSchema).min(1) with no cap on phase count (src/config/plan-schema.ts:110) — there is no closed phase enum anywhere on this path. What bounds it is the close-time evidence wipe: baselineRelPath resolves through validateSwarmPath (src/tools/sast-baseline.ts:191,512) to .swarm/evidence/{phase}/sast-baseline.json, a true subpath of the tree that ACTIVE_STATE_DIRS_TO_CLEAN removes recursively at /swarm close (src/commands/close/constants.ts:253-269; src/commands/close/clean-stage.ts:176-190). CAVEAT (verified): the taskId-keyed archiveEvidence retention does NOT reach these directories — it looks for evidence/{taskId}/evidence.json and silently skips a phase directory that has none (src/evidence/manager.ts:676-738) — so /swarm close is the ONLY reclaim path here, and one directory accumulates per distinct phase number until it runs.',
			citation: 'src/tools/sast-baseline.ts:65-68',
		},
		readBound: { pattern: 'full-file', bound: '≤2 MiB by write-side cap', sync: true, citation: 'src/tools/sast-baseline.ts:68,861' },
		lockModel: 'O_EXCL advisory lock with backoff, degrades to no-lock after retries (:74,403-443)',
		crashBehavior: 'temp+rename; lock released in finally',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'typed load results (not_found/invalid_schema/found); 1.0.0 baselines load exact-only (#2302) and upgrade at next capture',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Hard caps 2000 findings / 2 MiB with write-side truncation (src/tools/sast-baseline.ts:65-68,690-712).' },
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 5 — plan durability, evidence bundles, council
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'plan-ledger',
		category: 5,
		pathGrammar: '.swarm/plan-ledger.jsonl portable shadow/export + project DB plan_ledger_* tables (+ content-addressed legacy archives, reconcile archives, quarantine suffixes)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/plan/ledger.ts', 'src/plan/ledger-sqlite.ts'],
		writerCitations: [
			'src/plan/ledger.ts:1015 initLedger / :1314 appendLedgerEvent — authority-mode coordinator under LEDGER_LOCK; SQLite event+state uses FULL transactions and JSONL is the exact portable stream',
			'src/plan/ledger.ts:1626 takeSnapshotEvent; :1688 replaceTruncatedLedgerWithRecoveryRoot (corruption recovery ONLY, original content-addressed before replacement)',
			'src/plan/ledger-sqlite.ts — registry-backed SQLite event/state/import mutations; every transaction uses synchronous=FULL through the project DB durability policy',
		],
		readerCitations: [
			'src/plan/ledger.ts:998 readLedgerEvents / :2335 readLedgerEventsWithIntegrity — authority-mode coordinator; JSONL full-file replay in file-shadow mode, ordered SQLite rows after cutover',
			'src/plan/ledger.ts:984 getLatestLedgerSeq / loadLastApprovedPlan — coordinated authority reads',
		],
		schemaVersion: 'versioned plan events (docs/plan-durability.md)',
		stateClass: 'authoritative',
		privacyClass: 'content',
		directFileExemption: {
			reason: 'The exact JSONL stream is retained without truncation as the authority during the one-release file-shadow rollout and as the portable rollback/export surface after SQLite cutover; corruption recovery content-addresses the original. SQLite plan-ledger rows share the bounded project-DB lifecycle.',
			reviewedIssue: 2484,
		},
		writeLimits: {
			bound: 'append-only by contract — NO cap, NO sampling, NO truncation; only managed re-root/corruption recovery replaces the stream after content-addressing the original',
			scope: 'global',
			citation: 'docs/plan-durability.md; src/plan/ledger.ts:1274,1634,1798',
		},
		readBound: { pattern: 'full-file', bound: 'JSONL is read fully only while it is the file-shadow authority; after cutover, ordered SQLite rows are authoritative and JSONL is repaired as a portable export', sync: true, citation: 'src/plan/ledger.ts:629-780,2269-2308' },
		lockModel: 'withEvidenceLock on the ledger path + optimistic CAS retry (appendLedgerEventWithRetry :1463); SQLite mutations also use BEGIN IMMEDIATE FULL transactions',
		crashBehavior: 'file-shadow writes use fsync-then-rename and repair SQLite by exact prefix; SQLite-authority writes commit event+state atomically and repair export failures on a later read',
		closePolicy: 'archived + terminal-state REMOVED unconditionally so a closed plan cannot resurrect (src/commands/close/clean-stage.ts:324-356); transient ledger siblings removed, but content-addressed legacy archives remain for retention (src/commands/close/clean-stage.ts:221-241)',
		closeArrayMembership: {
			'plan-ledger.jsonl': 'archive+clean',
		},
		resetPolicy: 'close/finalize is the lifecycle boundary',
		legacyCompatibility: 'checkpoints read 3 legacy locations with deprecation warnings (plan/checkpoint.ts:95-119); plan-ledger legacy archives are content-addressed and retention-bounded to newest 16 after a 30 d horizon (src/retention/sweep.ts)',
		healthSignal: 'authority_mode + parity_status/replay hashes in plan_ledger_state; truncated flag + quarantine file presence during file-shadow recovery',
		owner: 'this-gate',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'docs/plan-durability.md + AGENTS.md invariant 5: authority is persisted in plan_ledger_state; JSONL remains an exact no-truncation shadow/export and close archives then removes the whole project-DB lifecycle.',
		},
	},
	{
		id: 'plan-projections',
		category: 5,
		pathGrammar: '.swarm/plan.json + .swarm/plan.md',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/plan/manager.ts',
			'src/commands/rollback.ts',
			'src/commands/reset.ts',
		],
		writerCitations: [
			'src/plan/manager.ts:1715 savePlan — plan.json temp+rename; :1761 plan.md; :1901 rebuildPlan; :2090 closePlanTerminalState',
			'src/commands/rollback.ts — lifecycle-locked checkpoint projection publication with prior-byte compensation after authoritative re-root',
			'src/commands/reset.ts — lifecycle-locked critical projection deletion with prior-byte compensation when authority cleanup aborts',
		],
		readerCitations: ['src/plan/manager.ts:656 loadPlan — full-file with auto-heal + ledger-replay fallback, async; :366 loadPlanJsonOnly'],
		schemaVersion: 'plan schema (projections of the ledger)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'content',
		writeLimits: { bound: 'single rewritten files derived from the ledger (rebuildable by replay)', scope: 'global', citation: 'src/plan/manager.ts:1931-2051' },
		readBound: { pattern: 'full-file', bound: 'single plan document', sync: false, citation: 'src/plan/manager.ts:656-726' },
		lockModel: 'tryAcquireLock on plan.json (manager.ts:1244-1248) + plan lock for mutations',
		crashBehavior: 'atomic writes; torn projection refused overwriting by truncated-ledger guard (:726-754)',
		closePolicy: 'archived+cleaned (plan.json/plan.md in both close lists; terminal-state removal)',
		closeArrayMembership: {
			'plan.json': 'archive+clean',
			'plan.md': 'archive+clean',
		},
		resetPolicy: 'close is the boundary',
		legacyCompatibility: 'auto-migrate from plan.md when plan.json missing/invalid (:1005-1042)',
		healthSignal: 'stale-projection reconciliation',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Derived projections of the authoritative ledger — rebuildable by replay, atomically written, close-scoped (src/plan/manager.ts:1931-2051).' },
	},
	{
		id: 'plan-checkpoints-exports',
		category: 5,
		pathGrammar: '.swarm/plan-export/SWARM_PLAN.{json,md} (+ legacy .swarm/SWARM_PLAN.* and <root>/SWARM_PLAN.*)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/plan/checkpoint.ts', 'src/tools/checkpoint.ts'],
		writerCitations: [
			'src/plan/checkpoint.ts:39 writeCheckpoint / :90 importCheckpoint (re-persist + plan_rebuilt event :137-141)',
			'src/tools/checkpoint.ts:195 writeCheckpointLog (checkpoints.json, FIFO max_retention default 20 :217,246-258) + :206 appendRetentionEvent',
		],
		readerCitations: ['src/plan/checkpoint.ts:95-119 — 3-location legacy reads with advisoryWarn deprecations; src/tools/checkpoint.ts:175 readCheckpointLog'],
		schemaVersion: 'checkpoint/export artifacts (issue #852 scoping)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'bounded export set; checkpoints.json FIFO 20 default (checkpoint.max_retention)', scope: 'global', citation: 'src/tools/checkpoint.ts:217,246-258' },
		readBound: { pattern: 'full-file', bound: 'single checkpoint document / ≤20-entry log', sync: true, citation: 'src/tools/checkpoint.ts:175; src/plan/checkpoint.ts:90-119' },
		lockModel: 'withCheckpointMutationLock (proper-lockfile on checkpoints.json, tools/checkpoint.ts:545-644)',
		crashBehavior: 'temp+rename; git commit precedes checkpoint recording',
		closePolicy: 'archived + removed from all three locations (src/commands/close/clean-stage.ts:254-286)',
		resetPolicy: 'close removes',
		legacyCompatibility: 'three-location reads with deprecation warnings; cleanup removes all three',
		healthSignal: 'retention events (checkpoint_retention_applied)',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Scoped export artifacts (issue #852) with FIFO-bounded checkpoint log and three-location close cleanup (src/tools/checkpoint.ts:217; src/commands/close/clean-stage.ts:254-286).' },
	},
	{
		id: 'evidence-bundles',
		category: 5,
		pathGrammar: '.swarm/evidence/{taskId}/evidence.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/evidence/manager.ts', 'src/tools/write-retro.ts', 'src/tools/sbom-generate.ts', 'src/summaries/manager.ts'],
		writerCitations: [
			'src/evidence/manager.ts:193 saveEvidence — withEvidenceLock, bundle trim MAX_BUNDLE_ENTRIES 100 (:261-265), EVINENCE_MAX_JSON_BYTES 500 KiB, temp+rename :286-296',
			'src/evidence/manager.ts:665 archiveEvidence — retention maxAgeDays 30 / maxBundles 10 defaults (src/commands/close/archive-stage.ts:498-544)',
			'src/summaries/manager.ts:132 storeSummary — atomic (summaries row below owns lifecycle)',
		],
		readerCitations: ['src/evidence/manager.ts:387 loadEvidence — full-file Zod-validated with legacy migration, async; :515 listEvidenceTaskIds — directory list'],
		schemaVersion: 'EvidenceBundle schema_version; legacy flat retrospective migrated in place (:319-480)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: '≤100 entries + ≤500 KiB per bundle; retention 30 d / 10 bundles; evidence/ close-scoped',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY A REAL GLOBAL REAPER: one key per taskId bundle directory, and archiveEvidence enumerates the ENTIRE keyspace via listEvidenceTaskIds(directory) and deletes across it (src/evidence/manager.ts:676-738) — the maxAgeDays/maxBundles retention selects victims by comparing every remaining bundle against a global count (src/evidence/manager.ts:719-730), so unlike the ≤100-entry/≤500-KiB per-bundle cap in this row\'s `bound` field, that retention IS a keyspace bound. Belt-and-braces, "evidence" is also in ACTIVE_STATE_DIRS_TO_CLEAN and the whole tree is recursively removed at close (src/commands/close/constants.ts:253-269; src/commands/close/clean-stage.ts:176-190). CAVEAT: archiveEvidence has exactly two callers — /swarm close (src/commands/close/archive-stage.ts:531-536, 30 d / 10 bundles), where the subsequent full-tree removal makes it largely redundant, and the operator-invoked /swarm archive (src/commands/archive.ts:95, 90 d / 1000 bundles). It is not wired to any automatic interval, so mid-session reclamation requires one of those two commands to run.',
			citation: 'src/evidence/manager.ts:261-280; src/commands/close/archive-stage.ts:498-544',
		},
		readBound: { pattern: 'full-file', bound: '≤500 KiB per bundle by write-side enforcement', sync: false, citation: 'src/evidence/manager.ts:275-280,387-416' },
		lockModel: 'withEvidenceLock per bundle',
		crashBehavior: 'atomic write + cache invalidation after rename (:308)',
		closePolicy: 'cleaned — evidence/ dir lifecycle (after retention archiving)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'one-time in-place legacy migration under lock',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Hard per-bundle caps (100 entries / 500 KiB) + age/count retention + close lifecycle (src/evidence/manager.ts:261-280,665; src/commands/close/archive-stage.ts:498-544).' },
	},
	{
		id: 'phase-participation',
		category: 5,
		pathGrammar: '.swarm/evidence/phase-participation.json (+ phase-participation-quarantine/{sha}.bin)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/evidence/phase-participation.ts'],
		writerCitations: ['src/evidence/phase-participation.ts:490 writeStore — byte-limit trim evicting oldest pending/receipts; quarantine on corruption :376-446'],
		readerCitations: ['src/evidence/phase-participation.ts:821 readPhaseParticipation — bounded raw read (:215, ≤256 KiB, symlink guards), sync'],
		schemaVersion: 'store schema with workspace freshness validation',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Workspace-fresh phase-participation receipts are validated against the workspace on every read and byte-trimmed on write under the evidence lock — a self-contained authority (256 KiB, ≤128 pending/receipts, bounded quarantine) with no DB-mediated equivalent.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'MAX_PHASE_PARTICIPATION_BYTES 256 KiB (:36); PENDING ≤128; RECEIPTS ≤128 (:37-38); quarantine ≤16 files / 1 MiB / 64 entries (:39-41)', scope: 'global', citation: 'src/evidence/phase-participation.ts:36-43' },
		readBound: { pattern: 'full-file', bound: '≤256 KiB by write-side trim', sync: true, citation: 'src/evidence/phase-participation.ts:215,36' },
		lockModel: 'withEvidenceLock on the store path (:159-165,643-652,733-738)',
		crashBehavior: 'atomic write; corrupt store quarantined then reset empty',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'workspace freshness check rejects stale stores',
		healthSignal: 'quarantine presence',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Hard byte/entry caps (256 KiB/128/128) with eviction and corruption quarantine (src/evidence/phase-participation.ts:36-43).' },
	},
	{
		id: 'council-round-state-attempts',
		category: 5,
		pathGrammar: '.swarm/council/round-state/{token}.json + .swarm/council/attempts/{token}.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/council/council-round-state.ts',
			'src/tools/submit-phase-council-verdicts.ts',
			'src/tools/write-final-council-evidence.ts',
			'src/tools/convene-general-council.ts',
		],
		writerCitations: [
			'src/council/council-round-state.ts:726 writeState (atomic) + :552-560 audit append with fsync; recoverAuditHistory :305-392 replays audit tail',
			'submit-phase-council-verdicts.ts / write-final-council-evidence.ts — recordUnscopedCouncilAttempt paths',
		],
		readerCitations: ['src/council/council-round-state.ts:568 readAuditTail — LINE-BOUNDED last 256 KiB (MAX_AUDIT_TAIL :19); :761 loadState with audit recovery'],
		schemaVersion: 'round state + audit trail (implicit quorumSize default)',
		stateClass: 'authoritative',
		privacyClass: 'mixed',
		directFileExemption: {
			reason: 'Durable-every-attempt council semantics (#2046) require the fsynced round-state/attempts files to outlive any single verdict path; growth is bounded at close (council/ in the clean dirs), the audit reader is tail-bounded (≤256 KiB), and the per-token round domain is finite (MAX_ROUND 10).',
			reviewedIssue: 2046,
		},
		writeLimits: {
			bound: 'MAX_ROUND 10 (:18); audit-tail read ≤256 KiB; council/ dir archived+cleaned at close (src/commands/close/constants.ts:255)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY CLOSE plus a bounded token domain: council/ is in ACTIVE_STATE_DIRS_TO_CLEAN (src/commands/close/constants.ts:255), so every round-state/{token}.json and attempts/{token}.jsonl is removed at /swarm close on one global trigger; within a session the per-token round domain is finite (MAX_ROUND 10, src/council/council-round-state.ts:18) and the audit reader is tail-bounded (readAuditTail ≤256 KiB, src/council/council-round-state.ts:19,568).',
			citation: 'src/council/council-round-state.ts:18-19; src/commands/close/constants.ts:255',
		},
		readBound: { pattern: 'line-bounded', bound: '≤256 KiB audit tail', sync: true, citation: 'src/council/council-round-state.ts:19,568' },
		lockModel: 'withEvidenceLock on round-state path',
		crashBehavior: 'fsynced audit append before state; state recoverable from bounded audit tail',
		closePolicy: 'cleaned — council/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'maxRoundsExhausted transitions',
		owner: '#2046 (durable-every-attempt semantics); #2483 (bounded-at-close review)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Issue #2046 durable-every-attempt semantics require the round-state/attempts authority to persist every attempted round before a verdict path can return; growth is bounded at close (council/ in ACTIVE_STATE_DIRS_TO_CLEAN, src/commands/close/constants.ts:255), the audit reader is tail-bounded (readAuditTail ≤256 KiB, src/council/council-round-state.ts:19,568), and the per-token round domain is finite (MAX_ROUND 10, src/council/council-round-state.ts:18).',
		},
	},
	{
		id: 'council-criteria',
		category: 5,
		pathGrammar: '.swarm/council/{safeId(taskId)}.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/council/criteria-store.ts'],
		writerCitations: ['src/council/criteria-store.ts:33 writeCriteria — atomic'],
		readerCitations: ['src/council/criteria-store.ts:53 readCriteria — single file, sync'],
		schemaVersion: 'criteria schema (safeId dots→underscores :71-73)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'one criteria file per task; council/ dir close-scoped',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER, not by key domain: one key per safeId(taskId) flat file under .swarm/council/ (src/council/criteria-store.ts:39,48), and safeId only sanitizes characters for filesystem safety (:71-73) — it constrains the SHAPE of a key, never how many keys exist. The GLOBAL deleter is the close clean loop: "council" is in ACTIVE_STATE_DIRS_TO_CLEAN (src/commands/close/constants.ts:253-269) and the loop recursively removes .swarm/council/ entire (src/commands/close/clean-stage.ts:176-190), taking every criteria file (and the sibling round-state/ and attempts/ subtrees) in one pass. CAVEAT: archive-first-gated (src/commands/close/clean-stage.ts:176-185); /swarm reset and /swarm reset-session leave council/ alone, so a session that never closes retains one file per distinct taskId passed to declare_council_criteria.',
			citation: 'src/commands/close/constants.ts:255',
		},
		readBound: { pattern: 'indexed', bound: 'single JSON per task', sync: true, citation: 'src/council/criteria-store.ts:53' },
		lockModel: 'atomic write (single writer per task)',
		crashBehavior: 'temp+rename',
		closePolicy: 'cleaned — council/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Per-task single artifact under the close-cleaned council/ directory (close.ts ACTIVE_STATE_DIRS_TO_CLEAN).' },
	},
	{
		id: 'council-evidence-files',
		category: 5,
		pathGrammar: '.swarm/evidence/{phase}/phase-council.json + .swarm/evidence/final-council.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/tools/submit-phase-council-verdicts.ts', 'src/tools/write-final-council-evidence.ts'],
		writerCitations: [
			'src/tools/submit-phase-council-verdicts.ts:407 writePhaseCouncilEvidence — EvidenceBundle-shaped',
			'src/tools/write-final-council-evidence.ts:137 executeWriteFinalCouncilEvidence — generation-locked to plan hash, withEvidenceLock',
		],
		readerCitations: ['hasPhaseEvidenceAttempt :378 / hasFinalEvidenceAttempt :414 — attempt checks'],
		schemaVersion: 'EvidenceBundle-shaped entries',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'per-phase/per-final single artifacts; evidence/ close-scoped', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:256' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: false, citation: 'src/tools/write-final-council-evidence.ts:414' },
		lockModel: 'withEvidenceLock; final council generation-locked',
		crashBehavior: 'atomic writes',
		closePolicy: 'cleaned — evidence/ dir lifecycle',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Session-scoped single artifacts under the close-cleaned evidence/ directory; attempt durability semantics owned separately by #2046.' },
	},
	{
		id: 'record-receipt-artifacts',
		category: 5,
		pathGrammar: '.swarm/{implementation-review,issue-publication,reproduction,recurrence-sweep}.json + .swarm/{issue-trace-state,issue-reference}.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/tools/record-implementation-review.ts',
			'src/tools/record-issue-publication.ts',
			'src/tools/record-issue-reproduction.ts',
			'src/tools/record-recurrence-sweep.ts',
			'src/hooks/issue-trace-state.ts',
			'src/commands/issue.ts',
		],
		writerCitations: [
			'record-implementation-review.ts:87 / record-issue-publication.ts:74 / record-issue-reproduction.ts:85 / record-recurrence-sweep.ts:125 — atomic single JSONs with Zod-bounded fields',
			'issue-trace-state.ts:308 writeTraceState + issue.ts:216-264 — transactional two-artifact write with rollback (:243-288)',
		],
		readerCitations: ['issue-trace-state.ts:269,287 — full-file reads with legacy completed→status normalization (:242-252)'],
		schemaVersion: 'per-artifact Zod schemas (commands ≤200, text ≤4000 chars)',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten receipt files; bounded fields', scope: 'global', citation: 'record-issue-reproduction.ts:28-31; record-recurrence-sweep.ts:47-61' },
		readBound: { pattern: 'indexed', bound: 'single small JSONs', sync: true, citation: 'src/hooks/issue-trace-state.ts:287-302' },
		lockModel: 'atomic writes; issue pair is transactional with rollback',
		crashBehavior: 'temp+rename everywhere; fail-open reads',
		closePolicy: 'untouched (cross-run receipts by design — issue-tracer gates read them)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy completed field normalized',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single rewritten bounded receipt files (Zod-capped fields); no growth dimension (record-* tool schemas).' },
	},
	{
		id: 'spec-drift-artifacts',
		category: 5,
		pathGrammar: '.swarm/spec.md + .swarm/spec-staleness.json + .swarm/spec-snapshot.md (+ spec WAL) + .swarm/spec-archive/',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/services/spec-drift-recovery.ts',
			'src/plan/manager.ts',
			'src/hooks/system-enhancer.ts',
			'src/sdd/effective-spec.ts',
			'src/tools/save-plan.ts',
			'src/tools/spec-write.ts',
		],
		writerCitations: [
			'src/services/spec-drift-recovery.ts:207 writeWal (atomic) / :239 ensureSnapshotEvent / :278 appendEvent (verify-presence readback)',
			'src/plan/manager.ts:886-914 — spec-staleness marker write',
		],
		readerCitations: ['spec-drift-recovery.ts:115 parseMarker / :152 parseWal / :303 verifyEventPresence; sdd/effective-spec.ts read-only (bounded reads 256 KiB/512 KiB/100 files :11-14)'],
		schemaVersion: 'marker + WAL + ledger snapshots (source: spec_drift_recovery)',
		stateClass: 'authoritative',
		privacyClass: 'content',
		directFileExemption: {
			reason: 'The spec WAL/staleness marker is the drift-gate input that must hard-block save_plan in a NEXT session with no DB handle open; single-session state, unconditionally archived+cleaned at close so the next session starts drift-free.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'single-session drift state; spec-archive/ + spec.md + staleness + snapshot all in close clean sets', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:16-195; src/commands/close/constants.ts:253-269 (spec.md, spec-staleness.json, spec-snapshot.md, spec-archive)' },
		readBound: { pattern: 'full-file', bound: 'bounded spec reads (effective-spec.ts:11-14)', sync: true, citation: 'src/sdd/effective-spec.ts:11-14' },
		lockModel: 'tryAcquireLock on the staleness marker + plan lock via savePlan',
		crashBehavior: 'WAL atomic; audit append verified by readback',
		closePolicy: 'archived+cleaned — unconditional removal so next session starts drift-free (src/commands/close/constants.ts:67-78 docblock)',
		closeArrayMembership: {
			'spec.md': 'archive+clean',
			'spec-staleness.json': 'archive+clean',
			'spec-snapshot.md': 'archive+clean',
		},
		resetPolicy: 'close is the boundary',
		legacyCompatibility: 'n/a',
		healthSignal: 'SPEC_DRIFT_BLOCK gate',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single-session drift state with atomic WAL, verified appends, and unconditional close cleanup (src/commands/close/constants.ts:67-78).' },
	},
	{
		id: 'workflow-wal-dirs',
		category: 5,
		pathGrammar: '.swarm/coder-settlements/{taskId}.json + .swarm/task-repairs/{taskId}.json + .swarm/task-terminals/ + .swarm/spec-archive/',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/workflow/coder-settlement.ts', 'src/workflow/task-repair.ts'],
		writerCitations: [
			'src/workflow/coder-settlement.ts:102 writeWal — per-task lock (withSettlementLock), atomic, state machine DISPATCHED→PREPARED→COMMITTED/ABORTED; MAX_LIVE_DISPATCHES 512 in-process (:54)',
			'src/workflow/task-repair.ts:168 writeWal — plan-lock-scoped recovery, verified audit append (:196-238)',
		],
		readerCitations: ['coder-settlement.ts:72 readWal / task-repair.ts:155 readWal — single-file per task'],
		schemaVersion: 'WAL state machines',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Crash-recovery WALs (coder-settlement/task-repair/task-terminals/spec-archive) must be readable before and independently of swarm.db during recovery — recovery is the one path that cannot depend on the DB being healthy; terminal states and the close-cleaned directories bound them.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'per-task WAL files; all four dirs in ACTIVE_STATE_DIRS_TO_CLEAN', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:253-269; coder-settlement.ts:54' },
		readBound: { pattern: 'indexed', bound: 'single JSON per task', sync: true, citation: 'src/workflow/coder-settlement.ts:72' },
		lockModel: 'per-task evidence locks; task-repair under plan lock',
		crashBehavior: 'atomic temp+rename; terminal states survive crash; recovery resumes from WAL',
		closePolicy: 'cleaned — all four dirs archived+cleaned',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'recovery outcomes',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Per-task crash-recovery WALs with locks and close-scoped directory lifecycle (close.ts ACTIVE_STATE_DIRS_TO_CLEAN).' },
	},
	{
		id: 'summaries',
		category: 5,
		pathGrammar: '.swarm/summaries/{S*}.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/summaries/manager.ts'],
		writerCitations: [
			'src/summaries/manager.ts:71 storeSummary — bunWrite+rename; cleanupSummaries (:284) age-based delete is now wired — the retention sweep is its first production caller (src/retention/sweep.ts:248)',
		],
		readerCitations: ['src/summaries/manager.ts:149 loadFullOutput — full-file; :253 listSummaries — directory list, newest-first capped at MAX_SUMMARIES_LISTED 500 (:191,:269)'],
		schemaVersion: 'summary schema',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'summaries.retention_days (default 7) enforced by the retention sweep\'s summaries-retention pass via cleanupSummaries (src/retention/sweep.ts:243-249; src/summaries/manager.ts:284); listSummaries newest-first capped at MAX_SUMMARIES_LISTED 500 (src/summaries/manager.ts:191,269)',
			scope: 'global',
			citation: 'src/summaries/manager.ts:284; src/retention/sweep.ts:248',
		},
		readBound: { pattern: 'indexed', bound: 'per-file reads; directory listing newest-first capped at MAX_SUMMARIES_LISTED 500', sync: false, citation: 'src/summaries/manager.ts:149,253' },
		lockModel: 'atomic writes; no cross-process lock',
		crashBehavior: 'temp+rename',
		closePolicy: 'untouched — the sweep owns the retention_days horizon',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 retention sweep runs the summaries-retention pass on every sweep trigger, calling cleanupSummaries with summaries.retention_days (default 7 — src/retention/sweep.ts:243-249; src/summaries/manager.ts:284): the previously-dead setting is live and files no longer accumulate; reads are newest-first capped at MAX_SUMMARIES_LISTED 500 (src/summaries/manager.ts:191,269).',
		},
	},
	{
		id: 'architecture-summaries',
		category: 5,
		pathGrammar: '.swarm/evidence/{taskId}.json agent-summary notes + .swarm/evidence/{phase}/{phase-architecture-summary.json,architecture-supervisor.json}',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/summaries/store.ts'],
		writerCitations: [
			'src/summaries/store.ts:56 writeAgentSummary — delegates to locked evidence storage',
			'src/summaries/store.ts:125 writePhaseArchitectureSummary — atomic sidecar replacement',
			'src/summaries/store.ts:163 writeSupervisorReport — atomic sidecar replacement',
		],
		readerCitations: [
			'src/summaries/store.ts:87 listAgentSummaries — evidence inventory',
			'src/summaries/store.ts:135 readPhaseArchitectureSummary — single-file read',
			'src/summaries/store.ts:210 readSupervisorReportRaw — single-file read',
		],
		schemaVersion: 'AgentWorkSummarySchema + phase/supervisor summary payloads',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'per-task/per-phase artifacts under the close-scoped evidence tree', scope: 'session-scoped', citation: 'src/commands/close.ts ACTIVE_STATE_DIRS_TO_CLEAN evidence entry' },
		readBound: { pattern: 'indexed', bound: 'single-file sidecars; agent summaries traverse the bounded evidence inventory', sync: false, citation: 'src/summaries/store.ts:87,135,210' },
		lockModel: 'agent summaries use evidence locks; sidecars use atomic replacement',
		crashBehavior: 'canonical atomic writes; malformed reads fail open',
		closePolicy: 'archived+cleaned as part of the evidence/ directory lifecycle',
		resetPolicy: 'close is the boundary',
		legacyCompatibility: 'n/a',
		healthSignal: 'malformed summary entries are skipped with warnings',
		owner: '#893',
		disposition: { kind: 'not-a-defect', proof: 'All artifacts are session-scoped beneath .swarm/evidence/, which is archived and recursively cleaned on close.' },
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 6 — knowledge family
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'knowledge-store',
		category: 6,
		pathGrammar: '.swarm/knowledge.jsonl (+ linked/hive store roots via link.json)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/hooks/knowledge-store.ts',
			'src/commands/dark-matter.ts',
			'src/hooks/knowledge-migrator.ts',
			'src/knowledge/scan-cursor.ts',
			'src/hooks/knowledge-curator.ts',
		],
		writerCitations: [
			'src/hooks/knowledge-store.ts:561 appendKnowledge / :598 rewriteKnowledge / :684 transactKnowledge / :726 transactKnowledgeWithCas — directory proper-lockfile (retries 5, stale 5000 :570-573)',
			'src/hooks/knowledge-store.ts:880 enforceKnowledgeCap (priority-aware, promoted entries protected :913-937); :962 sweepAgedEntries (in-place archive)',
			'src/commands/dark-matter.ts:58 appendKnowledge',
		],
		readerCitations: ['src/hooks/knowledge-store.ts:139 readKnowledge — FULL-FILE (uncapped reads cached; capped reads bypass), sync/async'],
		schemaVersion: 'knowledge entry schema (revision + content_hash via CAS)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'caller-configured maxEntries (swarm_max_entries default 100) enforced by enforceKnowledgeCap; aged entries archived in place; TODO sweep removes stale',
			scope: 'global',
			citation: 'src/hooks/knowledge-store.ts:880-937,962-1010,1029-1045',
		},
		readBound: { pattern: 'full-file', bound: 'bounded transitively by the configured entry cap', sync: true, citation: 'src/hooks/knowledge-store.ts:139-165,880' },
		lockModel: 'single directory lock serializing all .swarm JSONL knowledge writes (documented trade-off :678-683)',
		crashBehavior: 'atomic rewrites (temp+rename); append path fsync-free but single-line',
		closePolicy: 'archived-only — ARCHIVE_ARTIFACTS (src/commands/close/constants.ts:28-34), deliberately NOT cleaned (cross-session knowledge)',
		closeArrayMembership: {
			'knowledge.jsonl': 'archive-only',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'hive/link resolution via link.json; cohort stores resolved through identity',
		healthSignal: 'cap eviction + archive sweeps',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Configured entry cap with priority-aware eviction, in-place archival, and deliberate cross-session retention (src/hooks/knowledge-store.ts:880-1010; src/commands/close/constants.ts:28-34).' },
	},
	{
		id: 'knowledge-events',
		category: 6,
		pathGrammar: '.swarm/knowledge-events.jsonl + .swarm/knowledge-counter-baseline.json (+ hive shared-learnings-events.jsonl)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/knowledge-events.ts'],
		writerCitations: [
			'src/hooks/knowledge-events.ts:376 appendKnowledgeEvent / :396 appendKnowledgeEventsBatch — ONE lock + ONE trim pass (:406-437); :489 appendHiveKnowledgeEvent (FIFO 5000, no baseline folding)',
		],
		readerCitations: [
			'src/hooks/knowledge-events.ts:562 readKnowledgeEvents — full-file with optional cap, skips corrupt lines',
			'curator-postmortem / knowledge-escalator / knowledge-diagnostics / learning-metrics — diagnostic consumers; NO correctness consumer post-#2031',
		],
		schemaVersion: 'schema_version 1',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_EVENT_LOG_ENTRIES 5000 GLOBAL FIFO; evicted rows folded into knowledge-counter-baseline.json so counters survive rotation (:57,414-434,859-871)',
			scope: 'global',
			citation: 'src/hooks/knowledge-events.ts:57,406-437,859-871',
		},
		readBound: { pattern: 'full-file', bound: '≤5000 lines by FIFO + baseline folding', sync: true, citation: 'src/hooks/knowledge-events.ts:57' },
		lockModel: 'directory proper-lockfile retries 200 (batch) / stale 5000 (hive)',
		crashBehavior: 'trim best-effort after durable append; fail-open hot paths',
		closePolicy: 'untouched (bounded diagnostic stream)',
		closeArrayMembership: {
			'knowledge-events.jsonl': 'neither',
			'knowledge-counter-baseline.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy application records folded into recompute (:979-1007)',
		healthSignal: 'baseline fold counters',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Global 5000-entry FIFO with counter-baseline folding; post-#2031 diagnostic-only (no correctness consumer) — src/hooks/knowledge-events.ts:57,406-437.' },
	},
	{
		id: 'knowledge-application-legacy',
		category: 6,
		pathGrammar: '.swarm/knowledge-application.jsonl + .swarm/.knowledge-shown.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/hooks/knowledge-application.ts',
			'src/hooks/knowledge-application-gate.ts',
			'src/hooks/knowledge-reader.ts',
		],
		writerCitations: [
			'src/hooks/knowledge-application.ts:121 appendAudit — locked append, FIFO cap enforced after append (:143-145)',
			'src/hooks/knowledge-application-gate.ts:418 knowledgeApplicationTransformScan — commits via receipt ledger + legacy audit; warn events → events.jsonl :406',
		],
		readerCitations: ['src/hooks/knowledge-application.ts:403 getShownButNotAcknowledged — full-file; knowledge-events.ts:604 readLegacyApplicationRecords (counter rollups)'],
		schemaVersion: 'legacy v2 audit (n_a stored as acknowledged — documented lossiness)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'MAX_LEGACY_APPLICATION_LOG_ENTRIES 5000 FIFO (:40,143-145)', scope: 'global', citation: 'src/hooks/knowledge-application.ts:40,143-145' },
		readBound: { pattern: 'full-file', bound: '≤5000 lines by FIFO', sync: true, citation: 'src/hooks/knowledge-application.ts:403-439' },
		lockModel: 'directory proper-lockfile retries 50 / stale 5000',
		crashBehavior: 'cap best-effort after append; record failures warn only',
		closePolicy: 'untouched (bounded compatibility stream)',
		closeArrayMembership: {
			'knowledge-application.jsonl': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'IS the legacy stream — post-#2031 correctness lives in receipts-v2; retirement owned by #2051',
		healthSignal: 'n/a',
		owner: '#2051 (retirement owner)',
		disposition: { kind: 'not-a-defect', proof: 'Bounded 5000-entry FIFO compatibility stream; authoritative correctness partitioned to receipts-v2 by #2031 (src/hooks/knowledge-application.ts:40; docs/engineering-invariants.md #2031).' },
	},
	{
		id: 'knowledge-receipts-v2',
		category: 6,
		pathGrammar: '.swarm/knowledge-receipts-v2.jsonl (+ .snapshot.json + -archive.jsonl + -quarantine.json + .lock)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/knowledge-receipt-ledger-storage.ts'],
		writerCitations: [
			'src/hooks/knowledge-receipt-ledger-storage.ts:483 appendFsynced (dev/ino identity checks) / :540 atomicWriteFsynced (snapshot)',
			'src/hooks/knowledge-receipt-ledger.ts:1886 commitDisplayedMembership / :2098 validateAndCommitTerminalBatch / :2845 commitPhaseClosed (compaction trigger) / :2993 ensureLegacyCutover',
		],
		readerCitations: [
			'src/hooks/knowledge-receipt-ledger.ts:2673 queryLiveMemberships / :2709 queryHistoricalOutcomes (live + archive)',
			'promotion-evidence-store / application gates / destructive-policy checks — authority consumers',
		],
		schemaVersion: 'V2 journal + explicit cutover version',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'The #2031 authoritative correctness ledger: fsynced append with dev/ino identity checks, quarantine-on-corruption, and phase-close+grace compaction under a custom stale-recovering lock — journal ≤2000 records / archive ≤10000 hard-capped; a swarm.db table cannot reproduce the same one-process lock/quarantine discipline.',
			reviewedIssue: 2031,
		},
		writeLimits: {
			bound: 'MAX_JOURNAL_RECORDS 2000 / 32 MiB; MAX_ARCHIVE_RECORDS 10000 / 16 MiB; grace DEFAULT_RECEIPT_GRACE_DAYS 7; compaction moves closed+grace-elapsed to archive (capacity pressure retains live :2909-2927)',
			scope: 'global',
			citation: 'src/hooks/knowledge-receipt-ledger.ts:255-261,2863-2959',
		},
		readBound: { pattern: 'indexed', bound: 'journal ≤2000 records; archive ≤10000 — both hard-capped', sync: true, citation: 'src/hooks/knowledge-receipt-ledger.ts:255-259' },
		lockModel: 'custom receipt lock with stale-owner recovery (LOCK_TIMEOUT 500 ms, uninitialized-lock reclamation 30 s)',
		crashBehavior: 'fsynced append + identity checks; partial tail quarantined + truncated; snapshot failure never fails the commit',
		closePolicy: 'close may copy for forensics but NEVER deletes live or within-grace authority (#2031)',
		closeArrayMembership: {
			'knowledge-receipts-v2.jsonl': 'archive-only',
			'knowledge-receipts-v2.snapshot.json': 'archive-only',
			'knowledge-receipts-v2-archive.jsonl': 'archive-only',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy_unverifiable typed state for missing/evicted/linked membership — never inferred',
		healthSignal: 'receipt completion metrics (#2044 consumer)',
		owner: '#2031 (merged)',
		disposition: { kind: 'not-a-defect', proof: 'The #2031 partition: hard journal/archive caps, phase-close+grace compaction, cross-process lock, quarantine — the authoritative correctness store (src/hooks/knowledge-receipt-ledger.ts:255-261).' },
	},
	{
		id: 'knowledge-aux-lists',
		category: 6,
		pathGrammar: '.swarm/knowledge-{rejected,quarantined,unactionable,rewrites}.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/knowledge-validator.ts'],
		writerCitations: [
			'src/hooks/knowledge-validator.ts:869 quarantineEntry (cap 100, lock, atomic store rewrite + sidecar append) / :788 appendUnactionable (cap 200, Jaccard dedupe) / :1026 restoreEntry / :1178 unarchiveEntry',
			'rejected + rewrites written via knowledge-store.ts:1010 (cap 20) / :325 (MAX_REWRITE_HISTORY 2000)',
		],
		readerCitations: ['readKnowledge delegates (knowledge-store.ts:288-353); curator-postmortem reads unactionable ≤1000 (curator-postmortem.ts:43,1213)'],
		schemaVersion: 'per-list schemas',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'rejected FIFO 20 (default); quarantined FIFO 100; unactionable FIFO 200 (deduped); rewrites FIFO 2000',
			scope: 'global',
			citation: 'src/hooks/knowledge-store.ts:1013,330; src/hooks/knowledge-validator.ts:810,991-999',
		},
		readBound: { pattern: 'full-file', bound: '≤ cap per list (20/100/200/2000)', sync: true, citation: 'citations above' },
		lockModel: 'directory proper-lockfile (retries 5, stale 5000) — same knowledge lock domain',
		crashBehavior: 'atomic store rewrites under lock; quarantine moves are single-lock two-file operations',
		closePolicy: 'knowledge-rejected.jsonl archived+cleaned (ACTIVE_STATE_TO_CLEAN src/commands/close/constants.ts:160); others untouched (bounded)',
		closeArrayMembership: {
			'knowledge-rejected.jsonl': 'archive+clean',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'restore/unarchive paths return quarantined/archived entries',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Every list has a hard FIFO cap (20/100/200/2000) enforced under the knowledge lock (knowledge-store.ts:330,1013; knowledge-validator.ts:810,991-999).' },
	},
	{
		id: 'knowledge-retractions',
		category: 6,
		pathGrammar: '.swarm/knowledge-retractions.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/knowledge-store.ts'],
		writerCitations: ['src/hooks/knowledge-store.ts:328 appendRetractionRecord — appendCappedJsonl under the knowledge directory lock, MAX_RETRACTION_RECORDS 500 FIFO compaction (:348-352)'],
		readerCitations: ['src/hooks/knowledge-store.ts:314 readRetractionRecords — TAIL-BOUNDED readTailJsonl at the same 500-entry cap (:321-323)'],
		schemaVersion: 'retraction record schema',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_RETRACTION_RECORDS 500 FIFO enforced on every append (appendCappedJsonl, crash-atomic compaction) and the same cap bounds the tail reader',
			scope: 'global',
			citation: 'src/hooks/knowledge-store.ts:312,348',
		},
		readBound: { pattern: 'tail', bound: '≤500 newest records (readTailJsonl at the MAX_RETRACTION_RECORDS cap)', sync: true, citation: 'src/hooks/knowledge-store.ts:314' },
		lockModel: 'knowledge directory proper-lockfile around the capped append (retries 5, stale 5000)',
		crashBehavior: 'append + crash-atomic FIFO compaction (temp+rename)',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'knowledge-retractions.jsonl': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'MAX_RETRACTION_RECORDS 500 (src/hooks/knowledge-store.ts:312) is enforced on EVERY append via appendCappedJsonl\'s crash-atomic FIFO compaction (:328,348-352) and the reader is tail-bounded at the same cap (readTailJsonl, :314-323) — the uncapped-append gap behind the #2309 row is closed by the #2483 §2 cap.',
		},
	},
	{
		id: 'hive-stores',
		category: 6,
		pathGrammar: '<hive-data-dir>/shared-learnings.jsonl (+ -rejected.jsonl, -events.jsonl, -quarantined.jsonl)',
		canonicalRoot: 'platform-config',
		writerModules: [
			'src/hooks/hive-transaction.ts',
			'src/knowledge/identity.ts',
			'src/knowledge/family-migration.ts',
			'src/knowledge/hive-quarantine.ts',
			'src/knowledge/worktree-identity.ts',
		],
		writerCitations: [
			'src/hooks/hive-transaction.ts:165 transactHiveStore — single cross-process lock spanning read/validate/cap/staged-appends/atomic-persist (:206-316)',
			'src/knowledge/identity.ts:176 writeProjectIdentity — platform config identity.json',
			'src/knowledge/family-migration.ts — staged directory migration writes',
		],
		readerCitations: ['readKnowledge over hive paths (inside transactHiveStore); knowledge-events hive readers'],
		schemaVersion: 'knowledge entry schema; events FIFO 5000',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'store cap via HiveMutationOutcome.maxEntries under the same transaction; events FIFO 5000; rejected/quarantined sidecars deliberately NEVER trimmed (#2033 quarantine preservation :125-127)',
			scope: 'global',
			citation: 'src/hooks/hive-transaction.ts:116,125-127,245-253,400-409',
		},
		readBound: { pattern: 'full-file', bound: 'store capped by configured maxEntries; events ≤5000; rejected/quarantined preserved by invariant', sync: true, citation: 'src/hooks/hive-transaction.ts:245-253' },
		lockModel: 'proper-lockfile on hive dir stale 5000 — all writers share it',
		crashBehavior: 'atomic store persist; HiveStagedAppendError after rewrite requires caller compensation; quarantine rollback per #2033',
		closePolicy: 'untouched (cross-project hive)',
		resetPolicy: 'exact-ID quarantine with rollback (#2033) — never bulk delete',
		legacyCompatibility: 'family migration from legacy stores',
		healthSignal: 'staged-append compensation events',
		owner: '#2033 (merged)',
		disposition: {
			kind: 'retain-by-design',
			citation: '#2033 hive containment/quarantine contract: quarantined sidecars are evidence and must never be FIFO-trimmed (hive-transaction.ts:125-127); the store itself is capped inside the transaction; exact-ID quarantine with rollback is the sanctioned lifecycle.',
		},
	},
	{
		id: 'synonym-map',
		category: 6,
		pathGrammar: '.swarm/synonym-map.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/synonym-map.ts'],
		writerCitations: ['src/services/synonym-map.ts:381 writeSynonymMapAtomic — dir lock + temp+rename'],
		readerCitations: ['src/services/synonym-map.ts:354 readSynonymMap — bounded read ceiling (maxPairs×512 B, floor 64 KiB :288-290)'],
		schemaVersion: 'none',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'DEFAULT_MAX_PAIRS 500 LRU (:40); MAX_TOKEN_LENGTH 64 (:38)', scope: 'global', citation: 'src/services/synonym-map.ts:38-40' },
		readBound: { pattern: 'indexed', bound: 'read ceiling ≈ maxPairs×512 B', sync: true, citation: 'src/services/synonym-map.ts:288-290,365-379' },
		lockModel: 'directory proper-lockfile',
		crashBehavior: 'atomic with temp cleanup in finally',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'synonym-map.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'rebuildable from knowledge',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Bounded LRU map (500 pairs) with bounded reads and atomic locked writes (src/services/synonym-map.ts:38-40,288-290).' },
	},
	{
		id: 'recommendation-ledger',
		category: 6,
		pathGrammar: '<knowledgeStore>/learning/recommendation-ledger.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/recommendation-ledger.ts'],
		writerCitations: ['src/services/recommendation-ledger.ts:623 recordEmittedRecommendations — transactFile locked RMW, atomic persist, fail-open'],
		readerCitations: ['src/services/recommendation-ledger.ts:523 checkRecommendations / :383 readLedgerStrict — full-file'],
		schemaVersion: 'ledger schema (dedup fingerprints)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'MAX_RECOMMENDATION_LEDGER_ENTRIES 500 FIFO; MAX_ENTRY_BYTES 4096; ceiling ≈2 MiB (:131,140)', scope: 'global', citation: 'src/services/recommendation-ledger.ts:131,140' },
		readBound: { pattern: 'full-file', bound: '≤500 entries × 4 KiB', sync: true, citation: 'src/services/recommendation-ledger.ts:131-140' },
		lockModel: 'learning/ directory lock (disjoint from .swarm root)',
		crashBehavior: 'atomic; fail-open degrades to emitting all candidates',
		closePolicy: 'untouched (bounded)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'link-aware location',
		healthSignal: 'degraded flag',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Hard FIFO (500 × 4 KiB) with locked atomic persistence (src/services/recommendation-ledger.ts:131,140).' },
	},
	{
		id: 'link-pointers',
		category: 6,
		pathGrammar: '.swarm/link.json + .swarm/memory-link.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/knowledge-link.ts', 'src/memory/memory-link.ts', 'src/commands/link.ts', 'src/commands/memory-link.ts'],
		writerCitations: ['knowledge-link.ts writeLinkPointer / memory-link.ts:139 writeMemoryLinkPointer — atomic pointer writes; :151 removeMemoryLinkPointer rmSync'],
		readerCitations: ['memory-link.ts:94 readMemoryLinkPointer — full-file pointer read with cross-process revalidation cache (:179-187)'],
		schemaVersion: 'pointer schema',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Single pointer files routing the knowledge/memory stores to operator-chosen external roots — a pointer must be readable before any store, including swarm.db, can even be located; explicit link/unlink commands are the lifecycle.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'single pointer files', scope: 'global', citation: 'src/memory/memory-link.ts:138-159' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: true, citation: 'src/memory/memory-link.ts:93-135' },
		lockModel: 'none (atomic writes + stat-based revalidation)',
		crashBehavior: 'atomic; fail-open reads',
		closePolicy: 'untouched (cross-session link state)',
		closeArrayMembership: {
			'link.json': 'neither',
			'memory-link.json': 'neither',
		},
		resetPolicy: 'explicit unlink commands',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single atomic pointer files with explicit link/unlink lifecycle (src/memory/memory-link.ts:138-159).' },
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 7 — SQLite, memory stores, caches, repo graph
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'project-db',
		category: 7,
		pathGrammar: '.swarm/swarm.db (+ transient -wal/-shm sidecars)',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/db/project-db.ts',
			'src/db/coordination-store.ts',
			'src/db/qa-gate-profile.ts',
			'src/db/task-checkpoint-receipt.ts',
			'src/db/group-commit-writer.ts',
			'src/db/legacy-import.ts',
			'src/db/health.ts',
			'src/commands/archive-sqlite.ts',
		],
		writerCitations: [
			'src/db/project-db.ts getProjectDb — canonical-identity cache key, WAL + synchronous NORMAL default + busy_timeout 5000 + foreign_keys; versioned migrations v1-v28 with failed-migration recovery (migration_failures + marker fallback); closeProjectDb runs a best-effort TRUNCATE→PASSIVE WAL checkpoint',
			'src/db/coordination-store.ts transitionCoordinationState — FULL-durability event+state CAS, events capped at 2,048/stream and pruned toward 100,000 globally, idempotency fences capped at 8,192/stream and 400,000 globally, leases, and one-time imports (#2481)',
			'src/db/group-commit-writer.ts — queue → one BEGIN IMMEDIATE txn per flush with per-batch durability escalation (#2480)',
			'src/db/legacy-import.ts — one-txn idempotent legacy .jsonl/.json import + .imported cold-archive rename (#2480)',
			'src/commands/archive-sqlite.ts — WAL-consistent archive participant (#2030)',
		],
		readerCitations: ['qa-gate profile/constraint/checkpoint-receipt/insight-candidate/phase-report consumers — indexed SQL via the canonical cached handle'],
		schemaVersion: 'schema_migrations versioned (28)',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		writeLimits: { bound: 'bounded stores per DURABILITY_CLASSES; coordination events retain ≤2,048/stream and prune toward 100,000 globally; idempotency fences retain ≤8,192/stream and ≤400,000 globally; DB archived (WAL-consistent, #2030) + cleaned at close', scope: 'session-scoped', citation: 'src/db/coordination-store.ts; src/db/durability.ts; close.ts (swarm.db; -shm/-wal deliberately survive)' },
		readBound: { pattern: 'indexed', bound: 'SQL queries', sync: true, citation: 'src/db/project-db.ts' },
		lockModel: 'SQLite WAL + busy_timeout; ONE cached connection per canonical project identity (#2480: case/symlink variants share the handle)',
		crashBehavior: 'WAL auto-recovery on open; failed migrations recorded and retried',
		closePolicy: 'archived+cleaned — closeProjectDb checkpoints and releases Windows locks first',
		closeArrayMembership: {
			'swarm.db': 'archive+clean',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'forward migrations only; legacy store files imported by src/db/legacy-import.ts',
		healthSignal: 'diagnose swarm-db quick_check (#2480)',
		owner: '#2030 (merged)',
		disposition: { kind: 'not-a-defect', proof: 'WAL-mode DB with versioned migrations, per-table durability classes, canonical connection identity, and the #2030 WAL-consistent close archive+clean lifecycle (src/db/project-db.ts, src/db/durability.ts; close.ts).' },
	},
	{
		id: 'repo-memory-index',
		category: 7,
		pathGrammar: '.swarm/repo-memory.sqlite (+ transient -wal/-shm sidecars)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/tools/repo-graph/indexed-storage.ts'],
		writerCitations: [
			'src/tools/repo-graph/indexed-storage.ts:582 syncIndexFromGraph — full-replace transaction: DELETE FROM edges/files/graph_meta then re-INSERT every node/edge',
			'src/tools/repo-graph/storage.ts:690 syncIndexFromGraph — invoked from saveGraph only when the indexed-mode save lock was acquired, inside the lock span',
		],
		readerCitations: [
			'src/tools/repo-graph/indexed-storage.ts:940 queryNodeByFile — indexed single-row SELECT by path/module_name (resolveTargetRow), sync',
			'src/tools/repo-graph/indexed-storage.ts:988 loadSubgraphForFiles — bounded-neighbourhood closure via idx_edges_source/idx_edges_target, sync',
		],
		schemaVersion: 'schema_migrations versioned (6, indexed-storage.ts:91-136)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'full replace per save, not append-only (indexed-storage.ts:560-627 DELETE-then-reinsert); row count equals the live graph node/edge count, itself bounded by `repo_graph.max_files` (default 10,000, max 100,000 — src/config/schema.ts:1321)',
			scope: 'global',
			citation: 'src/tools/repo-graph/indexed-storage.ts:560-627; src/config/schema.ts:1321',
		},
		readBound: {
			pattern: 'indexed',
			bound: 'primary-key / indexed-column lookups (idx_files_module_name, idx_edges_source, idx_edges_target) over a bounded neighbourhood closure, never a full scan',
			sync: true,
			citation: 'src/tools/repo-graph/indexed-storage.ts:775-794 (resolveTargetRow), :796-818 (distinctSourcesOf/distinctTargetsOf)',
		},
		lockModel:
			'writes serialized by tryAcquireLock/_release on .swarm/locks/ (src/parallel/file-locks.ts), acquired in saveGraph (src/tools/repo-graph/storage.ts:504, released :670; helpers defined at acquireGraphSaveLock storage.ts:377-399, releaseGraphSaveLock :412-419) spanning rename -> stamp -> sync; plus SQLite WAL + busy_timeout=5000 (indexed-storage.ts:347)',
		crashBehavior:
			'a crash between the JSON rename and the index sync leaves the persisted stamp mismatched against a live stat of repo-graph.json; every reader falls back to the JSON path (openFreshIndex freshness check, indexed-storage.ts:685-745) and the next successful saveGraph repairs the index in one transaction — nothing is lost because repo-graph.json stays authoritative (indexed-storage.ts:4-19)',
		closePolicy:
			'archived+cleaned — same treatment as swarm.db: archived via archiveSqliteSnapshot (VACUUM INTO, src/commands/close/archive-stage.ts:255-313), with closeRepoMemory releasing the cached connection first to avoid Windows EBUSY on unlink (src/commands/close/clean-stage.ts:118-130); -wal/-shm sidecars deliberately neither archived nor cleaned (transient, recreated on next open — src/commands/close/constants.ts:55-64; src/commands/close/constants.ts:180-186)',
		closeArrayMembership: {
			'repo-memory.sqlite': 'archive+clean',
		},
		resetPolicy:
			'not reset — grep confirms neither src/commands/reset.ts nor src/commands/reset-session.ts reference repo-memory.sqlite, REPO_MEMORY_FILENAME, repo-graph.json, or repo_graph; the index is left on disk and self-heals via the stamp-mismatch fallback above',
		legacyCompatibility: 'forward migrations only; a store with a newer schema than this build resets itself (openForWrite, indexed-storage.ts:399-441)',
		healthSignal: 'n/a',
		owner: '#1534',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'a derived, wholesale-rebuilt accelerator over repo-graph.json: every write is a full DELETE+reinsert bounded by the same repo_graph.max_files ceiling that bounds the source graph (indexed-storage.ts:550-617; src/config/schema.ts:1321), never an unbounded append; corruption/staleness/budget-overrun/config-flip-to-json all delete it outright (indexed-storage.ts syncIndexFromGraph catch :618-624, openForRead corruption path :461-505, storage.ts:657) and the next save rebuilds it — there is no unbounded-growth or unreachable-cleanup failure mode.',
		},
	},
	{
		id: 'global-db',
		category: 7,
		pathGrammar: '<platformConfigDir>/global-rules.db',
		canonicalRoot: 'platform-config',
		writerModules: ['src/db/global-db.ts'],
		writerCitations: ['src/db/global-db.ts:91-103 getGlobalDb — WAL singleton + migrations'],
		readerCitations: ['global rules / prompt-section consumers — indexed SQL'],
		schemaVersion: 'schema_migrations versioned',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'user-authored global rules content (bounded by user input, not traffic)', scope: 'global', citation: 'src/db/global-db.ts:30-50' },
		readBound: { pattern: 'indexed', bound: 'SQL queries', sync: true, citation: 'src/db/global-db.ts:91-103' },
		lockModel: 'SQLite WAL + busy_timeout; process-wide singleton',
		crashBehavior: 'WAL auto-recovery',
		closePolicy: 'untouched (cross-project user content)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'forward migrations',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'retain-by-design', citation: 'User-authored global rules are governed content, not telemetry: retention is the user\'s own edit lifecycle; WAL + migrations provide durability.' },
	},
	{
		id: 'memory-sqlite',
		category: 7,
		pathGrammar: '.swarm/memory/memory.db (+ cohort roots)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/memory/sqlite-provider.ts', 'src/memory/memory-family-migration.ts'],
		writerCitations: [
			'src/memory/sqlite-provider.ts:615 upsert / :696 appendOutcome / :1106 recordRecallUsage / :1221 appendRewardEvent — BEGIN IMMEDIATE + WAL (:527-534); migrations :1817-1848; legacy JSONL import :2620-2727',
			'src/memory/memory-family-migration.ts — cohort family migration',
		],
		readerCitations: ['list/listRecallUsage/listRewardEvents — indexed SQL with LIMIT; loadMemories/loadProposals — full-table ordered scans (init path)'],
		schemaVersion: '11-step migration-versioned schema (_meta)',
		stateClass: 'authoritative',
		privacyClass: 'content',
		directFileExemption: {
			reason: 'memory.db is its own SQLite database — a separate cross-session memory store distinct from the project swarm.db by design; the reflection-service asserts the whole store ≤16 MiB fail-closed and eviction is explicit-only.',
			reviewedIssue: 2036,
		},
		writeLimits: {
			bound: 'no auto-eviction (explicit delete/compactMaintenance); reflection-service asserts total store ≤ MAX_STORE_BYTES 16 MiB (assertBoundedMemoryStore, memory/reflection-service.ts:43,335-373)',
			scope: 'global',
			citation: 'src/memory/reflection-service.ts:42-44,335-373',
		},
		readBound: { pattern: 'indexed', bound: 'SQL LIMIT queries; 16 MiB store assertion', sync: true, citation: 'src/memory/sqlite-provider.ts:1299-1373' },
		lockModel: 'BEGIN IMMEDIATE transactions + WAL busy_timeout',
		crashBehavior: 'WAL replay; checkpointCloseSnapshot truncates WAL for migration copies (:1468-1508)',
		closePolicy: 'untouched (cross-session memory; close does not archive memory/)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy JSONL auto-import on first init (LEGACY_JSONL_MIGRATION_VERSION 2)',
		healthSignal: 'reflection bounded-store assertion',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Store-size assertion ≤16 MiB (fail-closed health check) + WAL durability + explicit-only eviction (src/memory/reflection-service.ts:335-373).' },
	},
	{
		id: 'memory-jsonl-provider',
		category: 7,
		pathGrammar: '.swarm/memory/{memories,proposals,audit,reward-events,outcome-events}.jsonl (+ cohort roots)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/memory/local-jsonl-provider.ts'],
		writerCitations: ['src/memory/local-jsonl-provider.ts:207 upsert / :308 appendOutcome / :575 applyCuratorDecision / :910 rewriteMemoryFamilyUnlocked — dir lock + torn-tail repair (:1234) + atomic rewrites (:1221-1232)'],
		readerCitations: ['initialize/refreshMemoriesUnlocked (:158-205) — full-file loads; listRecallUsage/listRewardEvents — full-file filtered'],
		schemaVersion: 'legacy provider (migration source for SQLite)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'content',
		writeLimits: { bound: 'outcome events ≤1000 per memory (:252-260,322-330); memory entries capped by configured maxEntries (same cap as store)', scope: 'global', citation: 'src/memory/local-jsonl-provider.ts:252-260' },
		readBound: { pattern: 'full-file', bound: 'in-memory store bounded by configured cap', sync: true, citation: 'src/memory/local-jsonl-provider.ts:158-205' },
		lockModel: 'proper-lockfile stale 10 s, retries 20 (:734-747)',
		crashBehavior: 'torn-tail repair before append; atomic rewrites',
		closePolicy: 'untouched (legacy store; migrated forward)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'importJsonl/exportJsonl interop with SQLite provider',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Legacy provider retained as migration source with outcome caps, torn-tail repair, and configured entry cap parity with the SQLite store (src/memory/local-jsonl-provider.ts:252-260,1179).' },
	},
	{
		id: 'consolidation-log',
		category: 7,
		pathGrammar: '.swarm/memory/consolidation-log.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/memory/consolidation-log.ts'],
		writerCitations: ['src/memory/consolidation-log.ts:75 appendConsolidationLog — appendCappedJsonl with MAX_CONSOLIDATION_LOG_ENTRIES 500 FIFO (:81-84)'],
		readerCitations: ['src/memory/consolidation-log.ts:64 readConsolidationLog — TAIL-BOUNDED readTailJsonl at the same 500-entry cap (last-N CLI semantics kept)'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_CONSOLIDATION_LOG_ENTRIES 500 FIFO enforced on every append; reader tail-bounded at the same cap',
			scope: 'global',
			citation: 'src/memory/consolidation-log.ts:51,81',
		},
		readBound: { pattern: 'tail', bound: '≤500 newest records (readTailJsonl at the MAX_CONSOLIDATION_LOG_ENTRIES cap)', sync: true, citation: 'src/memory/consolidation-log.ts:64' },
		lockModel: 'none (appendCappedJsonl append+compaction)',
		crashBehavior: 'append + crash-atomic FIFO compaction (temp+rename); malformed lines skipped by the tail reader',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'MAX_CONSOLIDATION_LOG_ENTRIES 500 (src/memory/consolidation-log.ts:51) is enforced on every append via appendCappedJsonl (:75,81-84) and the reader is tail-bounded at the same cap (:64-72) — the uncapped-append + full-file-reader gap behind the #2309 row is closed by the #2483 §2 cap.',
		},
	},
	{
		id: 'memory-run-logs',
		category: 7,
		pathGrammar: '.swarm/runs/{runId}/memory.jsonl + .swarm/memory/unitid-probe.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/memory/run-log.ts', 'src/memory/injector.ts'],
		writerCitations: [
			'src/memory/run-log.ts:53 appendMemoryRunLog — appendCappedJsonl with MAX_RUN_LOG_ENTRIES 2000 FIFO per run file (:70-72)',
			'src/memory/injector.ts:519 maybeWriteUnitIdProbe — env-gated diagnostic (OPENCODE_SWARM_MEMORY_UNITID_PROBE=1); MAX_UNITID_PROBE_ENTRIES 2000 FIFO (:517,:545-547)',
		],
		readerCitations: ['consumers read JSONL directly (injector/reflection paths); each file ≤2000 entries by the write-side cap'],
		schemaVersion: 'run-log event shapes',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'per-run memory.jsonl capped at MAX_RUN_LOG_ENTRIES 2000 FIFO via appendCappedJsonl (src/memory/run-log.ts:51,70-72); unitid-probe.jsonl capped at MAX_UNITID_PROBE_ENTRIES 2000 (src/memory/injector.ts:517,545-547); runs/ dir archived+cleaned at close (src/commands/close/constants.ts:267) and age-pruned at 30 d by the retention sweep (src/retention/sweep.ts:99)',
			scope: 'global',
			citation: 'src/memory/run-log.ts:51; src/memory/injector.ts:517; src/commands/close/constants.ts:267',
		},
		readBound: { pattern: 'full-file', bound: 'per-run reads bounded transitively by the 2000-entry cap', sync: true, citation: 'src/memory/run-log.ts:53' },
		lockModel: 'none',
		crashBehavior: 'append + crash-atomic FIFO compaction (temp+rename)',
		closePolicy: 'runs/ dir archived+cleaned (ACTIVE_STATE_DIRS_TO_CLEAN src/commands/close/constants.ts:267) + 30 d sweep (src/retention/sweep.ts:99); unitid-probe is env-gated diagnostics',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Every run file is FIFO-capped at MAX_RUN_LOG_ENTRIES 2000 (src/memory/run-log.ts:51,70-72), the env-gated probe at MAX_UNITID_PROBE_ENTRIES 2000 (src/memory/injector.ts:517,545-547), and the runs/ directory now has a close lifecycle (ACTIVE_STATE_DIRS_TO_CLEAN, src/commands/close/constants.ts:267) plus the 30 d sweep family (src/retention/sweep.ts:99) — the #2309 accumulation gap is closed by #2483.',
		},
	},
	{
		id: 'reflections',
		category: 7,
		pathGrammar: '.swarm/reflections/lessons.{json,md}',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/memory/reflection-service.ts'],
		writerCitations: ['src/memory/reflection-service.ts:532 persistDigest — single atomicWriteSwarmFile under the reflection lock (:609)'],
		readerCitations: ['src/memory/reflection-service.ts:151 readReflectionDigest — bounded ≤256 KiB (MAX_INJECTION_READ_BYTES :41)'],
		schemaVersion: 'digest schema',
		stateClass: 'derived-rebuildable',
		privacyClass: 'content',
		writeLimits: { bound: 'MAX_REFLECTION_ENTRIES 2000 (:39); artifacts ≤256 KiB (:40); graph read ≤16 MiB (:42)', scope: 'global', citation: 'src/memory/reflection-service.ts:39-44' },
		readBound: { pattern: 'indexed', bound: '≤256 KiB read bound', sync: true, citation: 'src/memory/reflection-service.ts:41,154-160' },
		lockModel: 'proper-lockfile on reflections/ (stale 10 s, retries 20)',
		crashBehavior: 'atomic fsynced writes',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'regenerable digest',
		healthSignal: 'bounded-store assertion feeds health',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Entry cap 2000 + artifact byte caps + bounded reads (src/memory/reflection-service.ts:39-44).' },
	},
	{
		id: 'run-memory',
		category: 7,
		pathGrammar: '.swarm/run-memory.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/run-memory.ts'],
		writerCitations: ['src/services/run-memory.ts:100 recordOutcome — appendFile :101-104; recordTaskAttempt :176-232'],
		readerCitations: ['src/services/run-memory.ts:119 getTaskHistory / :321 getRunMemorySummary — FULL-FILE, line-parsed (summary capped 500 tokens :68)'],
		schemaVersion: 'none',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'no per-file cap; bounded by session — archived+cleaned at close (ACTIVE_STATE_TO_CLEAN src/commands/close/constants.ts:163)', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:35-38; src/commands/close/constants.ts:161-163 ("Plan-scoped per-attempt outcomes — archived first, then cleaned")' },
		readBound: { pattern: 'full-file', bound: 'session-scoped (close-cleaned)', sync: true, citation: 'src/services/run-memory.ts:114-140' },
		lockModel: 'none',
		crashBehavior: 'append; parse failures skipped',
		closePolicy: 'archived+cleaned',
		closeArrayMembership: {
			'run-memory.jsonl': 'archive+clean',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Session-scoped stream with explicit close archive+clean semantics documented in the clean list itself (src/commands/close/constants.ts:160-163).' },
	},
	{
		id: 'documents-cache',
		category: 7,
		pathGrammar: '.swarm/evidence-cache/documents.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/evidence/documents.ts', 'src/evidence/documents-retention.ts', 'src/commands/archive.ts'],
		writerCitations: [
			'src/evidence/documents.ts:48 writeEvidenceDocuments — appendFile, per-record text ≤4000 chars (:9,122-136)',
			'src/evidence/documents-retention.ts:377 pruneEvidenceDocuments — streamed line reader ≤100 MiB (:66), atomic rewrite, invoked by /swarm archive + close (:8-9, src/commands/close/archive-stage.ts:518-534)',
		],
		readerCitations: ['src/evidence/documents-retention.ts:195 readCacheRows — STREAMED with 100 MiB hard cap'],
		schemaVersion: 'document record schema',
		stateClass: 'derived-rebuildable',
		privacyClass: 'content',
		writeLimits: { bound: 'config cache_max_bytes (512 B–50 MiB) / cache_max_records (10–100k); no-op when unset (documented contract)', scope: 'per-trigger', citation: 'src/evidence/documents-retention.ts:66,95-103; docs/evidence-and-telemetry.md:68-80' },
		readBound: { pattern: 'line-bounded', bound: 'streamed ≤100 MiB read cap', sync: false, citation: 'src/evidence/documents-retention.ts:66,203-257' },
		lockModel: 'none during prune (append-vs-rewrite race accepted + documented :24-32)',
		crashBehavior: 'atomic rewrite with temp cleanup',
		closePolicy: 'pruned via close retention forwarding',
		resetPolicy: 'not reset',
		legacyCompatibility: 'redaction at write',
		healthSignal: 'prune counts',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Config-driven byte/record caps with streamed bounded reads and close-anchored prune; the append-vs-rewrite race is documented and accepted (documents-retention.ts:24-32).' },
	},
	{
		id: 'repo-graph',
		category: 7,
		pathGrammar: '.swarm/repo-graph.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/tools/repo-graph/storage.ts'],
		writerCitations: [
			'src/tools/repo-graph/storage.ts:339 saveGraph — atomic temp+rename with 5×100 ms Windows retry; :506 loadOrCreateGraph (COPYFILE_EXCL)',
		],
		readerCitations: [
			'src/tools/repo-graph/storage.ts:204 loadGraph / :293 loadGraphSync — FULL-FILE with validation behind a 16-workspace mtime-invalidated cache (cache.ts:13)',
			'src/memory/reflection-service.ts:386 loadBoundedGraph — ≤16 MiB',
		],
		schemaVersion: 'graph schema with workspaceRoot identity validation (:360-386)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'rebuildable from source (buildImpactMap/graph builder); archived+cleaned at close (ACTIVE_STATE_TO_CLEAN src/commands/close/constants.ts:164)', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:16-195; storage.ts:339-496' },
		readBound: { pattern: 'full-file', bound: 'cached + validated; reflection reader hard-bounded 16 MiB', sync: true, citation: 'src/memory/reflection-service.ts:42-43,375-395' },
		lockModel: 'no lockfile — atomic rename + mtime cache invalidation',
		crashBehavior: 'atomic writes; corrupt graph rejected and rebuilt',
		closePolicy: 'archived+cleaned',
		closeArrayMembership: {
			'repo-graph.json': 'archive+clean',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'workspace identity check prevents cross-root reuse',
		healthSignal: 'cache invalidation on mtime change',
		owner: 'this-gate',
		disposition: {
			kind: 'retain-by-design',
			citation: 'Rebuildable derived cache: proven rebuildable from source, read-bounded (16 MiB reflection cap + 16-workspace cache), and session-scoped (close archives+cleans repo-graph.json). Duplication/cost is an observation only — size alone authorizes no deletion (issue #2036 repo-graph clause).',
		},
	},
	{
		id: 'repo-graph-fingerprint',
		category: 7,
		pathGrammar: '.swarm/repo-graph.fingerprint.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/tools/repo-graph/freshness.ts'],
		writerCitations: ['src/tools/repo-graph/freshness.ts:520 writeFingerprint — temp+rename (:162-204)'],
		readerCitations: ['src/tools/repo-graph/freshness.ts:322 readFingerprint/probeFreshness — bounded ≤24 MiB / 100,256 entries (:43-44,322-351)'],
		schemaVersion: 'fingerprint schema',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'bounded read (24 MiB); the sidecar is archived+cleaned at close with its sibling repo-graph.json (#2483: src/commands/close/constants.ts:42; src/commands/close/constants.ts:166)', scope: 'session-scoped', citation: 'freshness.ts:43-44; src/commands/close/constants.ts:42; src/commands/close/constants.ts:166' },
		readBound: { pattern: 'indexed', bound: '≤24 MiB / ≤100,256 entries', sync: true, citation: 'src/tools/repo-graph/freshness.ts:43-44' },
		lockModel: 'none (atomic rename + probe cache TTL 30 s)',
		crashBehavior: 'atomic',
		closePolicy: 'archived+cleaned with its sibling repo-graph.json (#2483: ARCHIVE_ARTIFACTS src/commands/close/constants.ts:42, ACTIVE_STATE_TO_CLEAN src/commands/close/constants.ts:166)',
		closeArrayMembership: {
			'repo-graph.fingerprint.json': 'archive+clean',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The close orphan is closed: repo-graph.fingerprint.json is now in BOTH ARCHIVE_ARTIFACTS (src/commands/close/constants.ts:42) and ACTIVE_STATE_TO_CLEAN (src/commands/close/constants.ts:166), riding with its sibling repo-graph.json; reads stay bounded ≤24 MiB / ≤100,256 entries (src/tools/repo-graph/freshness.ts:43-44).',
		},
	},
	{
		id: 'test-history',
		category: 7,
		pathGrammar: '.swarm/cache/test-history.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/test-impact/history-store.ts'],
		writerCitations: ['src/test-impact/history-store.ts:194 batchAppendTestRuns / :316 appendTestRun — locked read-prune-write pass; the GLOBAL caps run in the same pass on EVERY append (:62-79)'],
		readerCitations: ['src/test-impact/history-store.ts:544 getTestHistory / :566 getAllHistory — full-file, sync'],
		schemaVersion: 'run record schema (bounded fields :20-22)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_HISTORY_PER_TEST 20 FIFO per (file,test) key (:19); GLOBAL MAX_TEST_HISTORY_ENTRIES 5000 entries + MAX_TEST_HISTORY_KEYS 1000 keys enforced in the read-prune-write pass on EVERY append (:36,:44,:62-79); bounded error/stack/changed-files fields',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY GLOBAL CAP, not by the key domain: MAX_TEST_HISTORY_KEYS 1000 caps the number of distinct (file,test) keys and MAX_TEST_HISTORY_ENTRIES 5000 caps total records — both enforced in the same read-prune-write pass on EVERY append (src/test-impact/history-store.ts:44,62-79,194), evicting least-recently-active keys outright once the caps bind. This closes the #2038-class keyspace gap this row recorded under #2309.',
			citation: 'src/test-impact/history-store.ts:19-25,62-79',
		},
		readBound: { pattern: 'full-file', bound: 'full-file reads bounded transitively by the GLOBAL 5000-entry cap enforced on every append', sync: true, citation: 'src/test-impact/history-store.ts:510,544' },
		lockModel: 'mkdir-based write lock with 60 s stale recovery (:373-432)',
		crashBehavior: 'atomic temp+rename rewrite',
		closePolicy: 'untouched (cache/)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 §2 caps close the #2038-class gap this row recorded under #2309: MAX_TEST_HISTORY_ENTRIES 5000 global entries + MAX_TEST_HISTORY_KEYS 1000 global keys are enforced in the read-prune-write pass on EVERY append (src/test-impact/history-store.ts:36,44,62-79,194), so renamed/deleted-test keys are dropped once the global caps bind; the per-key FIFO 20 (:19) remains the inner bound.',
		},
	},
	{
		id: 'impact-map',
		category: 7,
		pathGrammar: '.swarm/cache/impact-map.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/test-impact/analyzer.ts'],
		writerCitations: ['src/test-impact/analyzer.ts:518 saveImpactMap — plain writeFileSync :546 (non-atomic; rebuildable cache)'],
		readerCitations: ['src/test-impact/analyzer.ts:463 loadImpactMap — full-file + staleness check (per-file statSync)'],
		schemaVersion: 'impact map schema with generatedAt staleness',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'rebuildable via buildImpactMap (:449-455); size bounded by repository file population', scope: 'session-scoped', citation: 'src/test-impact/analyzer.ts:449-455' },
		readBound: { pattern: 'full-file', bound: 'rebuildable cache; stale entries rejected by mtime check', sync: true, citation: 'src/test-impact/analyzer.ts:49-65,469-515' },
		lockModel: 'none (rebuild-on-corruption)',
		crashBehavior: 'non-atomic write noted as observation — torn cache is detected by staleness/parse and rebuilt',
		closePolicy: 'untouched (cache/)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'isCacheStale',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Derived rebuildable cache with staleness detection; any torn write self-heals on rebuild (analyzer.ts:49-65,449-455).' },
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 8 — close/reset, worktree, doctor, session, warnings/automation
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'close-archive-bundles',
		category: 8,
		pathGrammar: '.swarm/archive/swarm-{timestamp}-{suffix}/',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/commands/close/archive-stage.ts'],
		writerCitations: ['src/commands/close/archive-stage.ts runArchiveStage — bundle swarm-{ts}-{suffix}; archive-first guard'],
		readerCitations: [
			'src/commands/close/orchestrator.ts:142-146 finalize idempotency — readdir + startsWith(swarm-) (filename-only)',
			'session-reflection.ts:424 — filename-only scan for reflection signals',
			'no production reader of bundle CONTENTS (verified)',
		],
		schemaVersion: 'preserves archived bytes verbatim',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'one bundle per finalize; each bundle bounded by the per-session caps of its contents; NO count/age prune across bundles',
			scope: 'per-trigger',
			citation: 'src/commands/close/archive-stage.ts:143-497 (no prune path — verified against source)',
		},
		readBound: { pattern: 'directory-scan', bound: 'filename-only scans; contents never re-read', sync: false, citation: 'src/commands/close/orchestrator.ts:142-146; session-reflection.ts:424' },
		lockModel: 'finalize.lock cross-process (src/commands/close/orchestrator.ts:535-557)',
		crashBehavior: 'archive-before-clean guard: active files unlinked only if archived (:1637-1671); archiveStageFailed prevents truthful-looking empty results',
		closePolicy: 'IS the close archive',
		resetPolicy: 'not reset; operator-managed',
		legacyCompatibility: 'WAL-consistent DB archive since #2030',
		healthSignal: 'close_archive_result telemetry + archive_valid flag',
		owner: '#2030 (merged)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Archives are the only durable copy of closed-session state after the clean stage (#2030 made them WAL-consistent and results truthful); the archive-first guard is the safety proof; reads are filename-only. No size-based deletion is authorized (issue #2036: "no cleanup authorization based on size alone"); bundle retention remains operator-owned.',
		},
	},
	{
		id: 'reset-backups',
		category: 8,
		pathGrammar: '.swarm/reset-backups/{kind}-{timestamp}/',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/commands/reset-backup.ts'],
		writerCitations: ['src/commands/reset-backup.ts:38 backupSwarmStateBeforeReset — cpSync fail-open; :117 pruneOldResetBackups'],
		readerCitations: ['restore is operator-driven (path reported to user, reset-session.ts:68)'],
		schemaVersion: 'verbatim copies',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: { bound: 'RESET_BACKUP_RETENTION 5 GLOBAL (:20, prune :125)', scope: 'global', citation: 'src/commands/reset-backup.ts:20,117-125' },
		readBound: { pattern: 'write-only', bound: 'n/a', sync: true, citation: 'no automated reader' },
		lockModel: 'none (synchronous cpSync)',
		crashBehavior: 'per-entry failures recorded as warnings, never thrown (:89-93)',
		closePolicy: 'untouched',
		resetPolicy: 'IS the reset safety mechanism (created before deletion)',
		legacyCompatibility: 'n/a',
		healthSignal: 'backup warnings',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Bounded retention (5) with automatic pruning (reset-backup.ts:20,117-125).' },
	},
	{
		id: 'worktree-status-owners',
		category: 8,
		pathGrammar:
			'.swarm/worktree-merge-status.json + .swarm/worktree-provisioning-owners/{sha256}.json + .swarm/worktree-provisioning-lifecycle.json + .swarm/worktree-merge-recovery-v2.json + .swarm/worktree-merge-recovery-v2-journal.json + .swarm/worktree-recovery-claims/{sha256}.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/hooks/delegation-gate/worktree-merge-status.ts',
			'src/hooks/delegation-gate/worktree-provisioning-owner.ts',
			'src/hooks/delegation-gate/worktree-recovery-authority.ts',
		],
		writerCitations: [
			'src/hooks/delegation-gate/worktree-merge-status.ts:259 recordWorktreeMergeFailure / :273 clearWorktreeMergeStatus — in-memory authority + atomic durable save (:103-125)',
			'src/hooks/delegation-gate/worktree-provisioning-owner.ts recordWorktreeProvisioningOwner/removeWorktreeProvisioningOwner — atomic per-owner files plus bounded lifecycle journal',
			'src/hooks/delegation-gate/worktree-recovery-authority.ts publish/claim/renew/release/finalize/replay — atomic authority, journal, and credential writes under one cross-process lock',
		],
		readerCitations: [
			'worktree-merge-status.ts:166 scanWorktreeMergeFailuresForRecovery — bounded 2 MiB / 512 entries (:59-60)',
			'worktree-provisioning-owner.ts scanWorktreeProvisioningOwnersForRecovery/scanWorktreeProvisioningLifecycleJournalForRecovery — ≤512 files / 16 KiB per file plus ≤256 KiB / 512-entry journal, fail-closed uncertain',
			'worktree-recovery-authority.ts bounded store/journal/credential readers and recovery scans — ≤2 MiB / 512 authority or journal entries and ≤16 KiB per credential',
		],
		schemaVersion: 'typed merge records; provisioning owners v1-v3/journal v1; recovery authority store v2/journal+credential v1',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Cross-session worktree recovery authority with hard byte/entry/file caps on every store and fail-closed recovery scans; recovery must not depend on a project DB that the orphaned worktree\'s session may never open again.',
			reviewedIssue: 2036,
		},
		writeLimits: {
			bound:
				'merge-status ≤2 MiB / ≤512 entries; owners ≤512 files / ≤16 KiB each; provisioning journal ≤256 KiB / 512 entries; recovery authority store+journal ≤2 MiB / 512 entries each; credentials ≤512 files / ≤16 KiB each',
			scope: 'global',
			citation:
				'worktree-merge-status.ts bounds; worktree-provisioning-owner.ts MAX_* constants; worktree-recovery-authority.ts MAX_* constants',
		},
		readBound: { pattern: 'directory-scan', bound: 'hard scan caps above', sync: true, citation: 'scan functions cited' },
		lockModel:
			'merge-status retains its legacy in-memory/atomic model; provisioning mutations hold the shared lifecycle lock at callers; all recovery-authority mutations use one stale-bounded cross-process lock',
		crashBehavior:
			'strict recovery scans fail closed; claim/provisioning journals replay bounded interrupted transitions; terminal recovery state repairs the store-write/journal-append crash window',
		closePolicy: 'untouched (cross-session recovery state)',
		closeArrayMembership: {
			'worktree-merge-status.json': 'neither',
			// Verified absent from both close.ts arrays (grep: no occurrence of
			// any of these three filenames in src/commands/close.ts), which is
			// what this row's `closePolicy: 'untouched'` already asserts.
			'worktree-provisioning-lifecycle.json': 'neither',
			'worktree-merge-recovery-v2.json': 'neither',
			'worktree-merge-recovery-v2-journal.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'recovery scan results',
		owner: 'this-gate',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Hard byte/entry/file caps on every store, bounded journals, exact teardown, and fail-closed recovery scans prevent unbounded retention or unsafe omission.',
		},
	},
	{
		id: 'worktree-lane-profiles',
		category: 8,
		pathGrammar: '<worktree>/.swarm/lanes/{laneIndex}.env',
		canonicalRoot: 'worktree',
		writerModules: ['src/worktree/core.ts'],
		writerCitations: ['src/worktree/core.ts:174 writeLaneProfileToDiskReal (fs.promises.writeFile :203); :219 removeLaneProfileFromDiskReal'],
		readerCitations: ['consumed by child processes (no plugin reader)'],
		schemaVersion: 'env key=value',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'one bounded env file per lane per worktree; removed at lane teardown (:219)',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY CONCURRENCY PLUS TEARDOWN — but NOT by the constant one would reach for: MAX_LANES=8 (src/tools/dispatch-lanes.ts:92) governs the unrelated dispatch_lanes fan-out tool and is not on this path (its only uses are src/tools/dispatch-lanes.ts:471,491,1045,1678). allocateStandardLaneIndex is monotonic per session with no clamp and no recycling (src/hooks/delegation-gate/worktree-isolation.ts:161-164), so the set of index VALUES ever issued grows with dispatch count — that is not the bound. The bound is that each {laneIndex}.env lives INSIDE its own worktree (src/worktree/core.ts:202-203, provisioned per session/task at :674-678): concurrently live worktrees sit under MAX_TRACKED_STANDARD_WORKTREE_CALLS=256 above a max_concurrent_tasks ceiling clamped to <=64 (src/hooks/delegation-gate/worktree-isolation.ts:166-173), each file is unlinked at lane teardown (src/worktree/core.ts:219-238), and re-dispatching the same taskId removes the prior worktree wholesale before recreating it (src/worktree/core.ts:863-892). Crash-orphaned worktrees are swept by a global reaper, runInitOrphanRecovery (src/hooks/init-orphan-recovery.ts:200-224, wired at src/index.ts:914). CAVEAT (verified, do not soften): that sweep runs only at plugin init, is timeout-wrapped and non-fatal (src/hooks/init-orphan-recovery.ts:54; src/index.ts:914-918), and enumerates only the default .swarm-worktrees base (src/hooks/init-orphan-recovery.ts:206-209) — worktrees provisioned under a custom worktree_dir (src/worktree/core.ts:581-582) fall outside its scan root entirely and are reclaimed only by their own teardown path.',
			citation: 'src/worktree/core.ts:174-230',
		},
		readBound: { pattern: 'write-only', bound: 'n/a', sync: false, citation: 'no plugin reader' },
		lockModel: 'none',
		crashBehavior: 'write failures swallowed at provisioning (:1013-1017)',
		closePolicy: 'worktree-scoped — removed with the worktree',
		resetPolicy: 'reset-session removes worktrees',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Worktree-scoped lane profile removed at teardown (worktree/core.ts:219).' },
	},
	{
		id: 'config-doctor-artifacts',
		category: 8,
		pathGrammar: '.swarm/config-doctor.json + .swarm/config-backup-{timestamp}.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/config-doctor.ts'],
		writerCitations: ['src/services/config-doctor.ts:2253 writeDoctorArtifact (rewritten per run, atomic :673); :737 writeBackupArtifact (pre-fix backups)'],
		readerCitations: ['src/services/config-doctor.ts:2194 readDoctorArtifact — fail-open; commands/doctor.ts:230 "Last run" trailer'],
		schemaVersion: 'doctor result schema',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten artifact + timestamped backups deleted by close (src/commands/close/clean-stage.ts:192-217)', scope: 'global', citation: 'src/commands/close/clean-stage.ts:192-217' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: true, citation: 'src/services/config-doctor.ts:2194-2248' },
		lockModel: 'atomic writes with Windows retry',
		crashBehavior: 'fail-open write/read',
		closePolicy: 'doctor artifact untouched; config backups cleaned at close',
		closeArrayMembership: {
			'config-doctor.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy numeric-hash restore support (:811-821)',
		healthSignal: 'doctor checks themselves',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Rewritten-per-run artifact; backups batch-deleted at close (config-doctor.ts:737; src/commands/close/clean-stage.ts:192-217).' },
	},
	{
		id: 'session-state-snapshot',
		category: 8,
		pathGrammar: '.swarm/session/{state.json, budget-state.json, session-start.jsonl, state.json.quarantine}',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/session/snapshot-writer.ts', 'src/session/snapshot-store.ts', 'src/session/session-start-store.ts', 'src/services/context-budget-service.ts'],
		writerCitations: [
			'src/session/snapshot-writer.ts:505 writeSnapshot — per-key SQLite snapshot authority via snapshot-store with serialized post-commit projection',
			'src/session/snapshot-store.ts writeSnapshotRows — FULL transaction with per-session tombstones and cross-process-safe disjoint updates',
			'src/session/session-start-store.ts:6 recordSessionStart — append flag a, fail-open',
			'src/services/context-budget-service.ts:196 writeBudgetState — bunWrite + cache invalidation',
		],
		readerCitations: ['src/session/snapshot-reader.ts:320 readSnapshot — full-file, version-validated (1-3), incompatible quarantined (:334-347); session-start-store.ts:22 readEarliestSessionStart — full-file min-scan'],
		schemaVersion: 'snapshot versions 1-3 (others quarantined)',
		stateClass: 'authoritative',
		privacyClass: 'content',
		directFileExemption: {
			reason: 'Per-session snapshot authority (versions 1-3, incompatible quarantined) under the close/reset-cleaned session/ tree; the snapshot must load before any DB-backed service warms up.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'single snapshot per session; session/ dir archived+cleaned at close; session-start.jsonl appends bounded by session length', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:257; reset-session.ts:91-133' },
		readBound: { pattern: 'full-file', bound: 'session-scoped files', sync: false, citation: 'src/session/snapshot-reader.ts:320-347' },
		lockModel: 'SQLite BEGIN IMMEDIATE across processes plus in-flight projection serialization',
		crashBehavior: 'SQLite WAL recovery; strict one-time legacy import fails closed; projection/archive repair is replayable',
		closePolicy: 'cleaned — session/ dir lifecycle',
		resetPolicy: 'reset-session deletes session/ contents (state.json explicitly :91-94)',
		legacyCompatibility: 'snapshot version migration 1→3',
		healthSignal: 'quarantine presence',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Session-scoped snapshot family under the close/reset-cleaned session/ directory with version-quarantine safety (src/commands/close/constants.ts:257; snapshot-reader.ts:334-347).' },
	},
	{
		id: 'full-auto-state',
		category: 8,
		pathGrammar: '.swarm/full-auto-state.json (+ .bak)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/full-auto/state.ts'],
		writerCitations: [
			'src/full-auto/state.ts:437 writePersisted — proper-lockfile cross-process (:210-253), .bak recovery (:385-417)',
			'start/pause/terminate/disarm/deny/oversight/escalation entry points :522-794; denialHistory ≤100 (:114,722-727)',
		],
		readerCitations: ['src/full-auto/state.ts:319 readPersisted — full-file mtime-cached, fail-open; :502 loadFullAutoRunState'],
		schemaVersion: 'state schema with unreadable fail-closed marker',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Cross-session automation state guarded by a cross-process proper-lockfile and .bak recovery; denialHistory capped 100 and the single-file rewrite has no growth dimension.',
			reviewedIssue: 2036,
		},
		writeLimits: { bound: 'single rewritten state; denialHistory capped 100; bounded by run lifecycle', scope: 'global', citation: 'src/full-auto/state.ts:114,722-727' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: true, citation: 'src/full-auto/state.ts:319-417' },
		lockModel: 'proper-lockfile lockSync with retries + 5 s stale',
		crashBehavior: '.bak recovery on corrupt canonical; stateUnreadable fail-closed permission hook (:271-301)',
		closePolicy: 'untouched (cross-session automation state)',
		closeArrayMembership: {
			'full-auto-state.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'fail-closed marker',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Cross-process locked, .bak-recoverable single state file with capped history (full-auto/state.ts:210-253,385-417).' },
	},
	{
		id: 'write-approval-ledger',
		category: 8,
		pathGrammar: '.swarm/authority/write-approvals.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/security/write-authority.ts'],
		writerCitations: [
			'src/security/write-authority.ts issueWriteApprovalFact / consumeWriteApprovalFact — transactFile serializes the read-modify-write cycle; ledgerWrite atomically rewrites the bounded tail',
		],
		readerCitations: [
			'src/security/write-authority.ts ledgerRead — full-file parse followed by a MAX_LEDGER_ENTRIES tail bound; writer keeps the durable file at the same bound',
		],
		schemaVersion: 'v1 issued/consumed discriminated JSONL entries',
		stateClass: 'authoritative',
		privacyClass: 'metadata',
		directFileExemption: {
			reason: 'Short-TTL one-shot write approval facts must be answerable by the security preflight with no DB dependency; the ledger is atomically rewritten under transactFile and hard-capped at MAX_LEDGER_ENTRIES 512.',
			reviewedIssue: 1824,
		},
		writeLimits: {
			bound: 'single rewritten ledger capped at MAX_LEDGER_ENTRIES=512',
			scope: 'global',
			citation: 'src/security/write-authority.ts MAX_LEDGER_ENTRIES, ledgerWrite',
		},
		readBound: {
			pattern: 'full-file',
			bound: 'at most 512 bounded-schema JSONL entries by write-side enforcement',
			sync: true,
			citation: 'src/security/write-authority.ts ledgerRead/ledgerWrite',
		},
		lockModel: 'transactFile per-path cross-process lock with atomic replacement',
		crashBehavior: 'atomic rewrite; malformed JSONL fails closed and issues no authority',
		closePolicy: 'untouched (cross-session, short-TTL approval authority; bounded compaction is retention)',
		resetPolicy: 'not reset; expired facts are ineligible and bounded tail compaction removes old entries',
		legacyCompatibility: 'absent ledger is an empty authority set',
		healthSignal: 'approval issue/consume result; malformed ledger surfaces a hard error',
		owner: '#1824',
		disposition: {
			kind: 'not-a-defect',
			proof: 'The authoritative ledger is atomically rewritten under transactFile, capped to 512 entries, and every grant expires and is one-shot (src/security/write-authority.ts).',
		},
	},
	{
		id: 'version-check-cache',
		category: 8,
		pathGrammar: '<XDG_CACHE_HOME>/opencode-swarm/version-check.json',
		canonicalRoot: 'xdg-cache',
		writerModules: ['src/services/version-check.ts'],
		writerCitations: ['src/services/version-check.ts:86 writeVersionCache — 24 h throttle (:23), fail-open'],
		readerCitations: ['src/services/version-check.ts:71 readVersionCache — fail-open; diagnose-service.ts:939 Version health'],
		schemaVersion: 'cache schema',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten cache; 24 h interval; HTTP response ≤256 KiB (:35)', scope: 'global', citation: 'src/services/version-check.ts:23,35' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: true, citation: 'src/services/version-check.ts:71-84' },
		lockModel: 'none (non-fatal races)',
		crashBehavior: 'fail-open both directions',
		closePolicy: 'outside project .swarm — unaffected',
		resetPolicy: 'n/a',
		legacyCompatibility: 'n/a',
		healthSignal: 'diagnose Version check',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single throttled cache file outside project state (version-check.ts:23,35,86).' },
	},
	{
		id: 'unacknowledged-criticals',
		category: 8,
		pathGrammar: '.swarm/unacknowledged-criticals.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/delegate-ack-collector.ts'],
		writerCitations: ['src/hooks/delegate-ack-collector.ts:121 appendUnacknowledgedCritical — appendCappedJsonl with MAX_UNACKNOWLEDGED_CRITICALS 500 FIFO (:131-143)'],
		readerCitations: ['write-only in production (escalator reads knowledge events, not this file — verified)'],
		schemaVersion: 'none',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'MAX_UNACKNOWLEDGED_CRITICALS 500 FIFO enforced on every append (appendCappedJsonl, crash-atomic compaction)',
			scope: 'global',
			citation: 'src/hooks/delegate-ack-collector.ts:112,130',
		},
		readBound: { pattern: 'write-only', bound: 'n/a', sync: false, citation: 'no production reader (verified)' },
		lockModel: 'none',
		crashBehavior: 'append + crash-atomic FIFO compaction (temp+rename); failures swallowed',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'unacknowledged-criticals.jsonl': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'MAX_UNACKNOWLEDGED_CRITICALS 500 (src/hooks/delegate-ack-collector.ts:112) is enforced on every append via appendCappedJsonl\'s crash-atomic FIFO compaction (:120,130-133) — the uncapped-audit gap behind the #2309 row is closed by the #2483 §2 cap.',
		},
	},
	{
		id: 'curation-proposals',
		category: 8,
		pathGrammar: '<knowledgeStore>/curation-proposals.jsonl (default .swarm/)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/knowledge/curation-policy.ts'],
		writerCitations: ['src/knowledge/curation-policy.ts:148 persistProposal — fire-and-forget appendCappedJsonl into the resolved knowledge store dir, MAX_CURATION_PROPOSALS 200 FIFO (:157-160)'],
		readerCitations: [
			'src/services/knowledge-diagnostics.ts:687 countPendingProposals — TAIL-BOUNDED readTailJsonl read of pending-status records (:699-705), async; reached via checkKnowledgeHealth (:658) from diagnose/knowledge-recall (PRR-008)',
		],
		schemaVersion: 'CurationProposal schema (status: pending is the only written value)',
		stateClass: 'operational',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'MAX_CURATION_PROPOSALS 200 FIFO enforced on every append; the diagnostics reader is tail-bounded at the same cap',
			scope: 'global',
			citation: 'src/knowledge/curation-policy.ts:120,157; src/services/knowledge-diagnostics.ts:699',
		},
		readBound: { pattern: 'tail', bound: '≤200 newest records (readTailJsonl at the MAX_CURATION_PROPOSALS cap)', sync: false, citation: 'src/services/knowledge-diagnostics.ts:687' },
		lockModel: 'none',
		crashBehavior: 'best-effort capped append + crash-atomic FIFO compaction; never blocks curation',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'pending-proposal count (knowledge health)',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'MAX_CURATION_PROPOSALS 200 (src/knowledge/curation-policy.ts:120) is enforced on every append (:148,157-160) and the countPendingProposals diagnostics reader is tail-bounded via readTailJsonl (src/services/knowledge-diagnostics.ts:687,699) — the uncapped-append + unbounded-reader gap behind the #2309 row is closed by the #2483 §2 cap.',
		},
	},
	{
		id: 'context-snapshot',
		category: 8,
		pathGrammar: '.swarm/context-snapshot.md',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/compaction-service.ts'],
		writerCitations: ['src/services/compaction-service.ts:99 appendSnapshot — appendCappedJsonl with MAX_CONTEXT_SNAPSHOT_BYTES 65536 whole-record-floor compaction (:117-125)'],
		readerCitations: ['none in production (on-demand inspection only — verified)'],
		schemaVersion: 'markdown entries',
		stateClass: 'operational',
		privacyClass: 'content',
		writeLimits: {
			bound: 'MAX_CONTEXT_SNAPSHOT_BYTES 65536 (64 KiB) whole-record-floor compaction on every append — the newest whole records that fit are kept and a non-empty snapshot is never emptied',
			scope: 'global',
			citation: 'src/services/compaction-service.ts:89,107',
		},
		readBound: { pattern: 'write-only', bound: 'n/a', sync: true, citation: 'no production reader (verified)' },
		lockModel: 'none',
		crashBehavior: 'append + crash-atomic byte-cap compaction; failures swallowed',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'context-snapshot.md': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'MAX_CONTEXT_SNAPSHOT_BYTES 65536 (src/services/compaction-service.ts:89) is enforced on every append via appendCappedJsonl with a whole-record floor — compaction keeps the newest records that fit and never empties a non-empty snapshot (:91,107-110) — the uncapped-append gap behind the #2309 row is closed by the #2483 §2 cap.',
		},
	},
	{
		id: 'capsules',
		category: 8,
		pathGrammar: '.swarm/capsules/{task_id}.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/context-map/capsule-persistence.ts'],
		writerCitations: ['src/context-map/capsule-persistence.ts:91 saveCapsule — temp+rename'],
		readerCitations: ['src/context-map/capsule-persistence.ts:155 loadCapsule — per-task full read; :207 listCapsules — newest-first capped at MAX_CAPSULES_LISTED 500 (:195,:229)'],
		schemaVersion: 'capsule schema (task-id regex validated :48)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'one file per task; the retention sweep\'s capsules family age-prunes at 30 d (src/retention/sweep.ts:98); listCapsules newest-first capped at MAX_CAPSULES_LISTED 500 (src/context-map/capsule-persistence.ts:195,229)',
			scope: 'global',
			citation: 'src/retention/sweep.ts:98; src/context-map/capsule-persistence.ts:195',
		},
		readBound: { pattern: 'indexed', bound: 'per-task reads; directory listing newest-first capped at MAX_CAPSULES_LISTED 500', sync: true, citation: 'src/context-map/capsule-persistence.ts:155,207' },
		lockModel: 'none (atomic writes)',
		crashBehavior: 'temp+rename; previous capsule preserved',
		closePolicy: 'untouched by close — the 30 d sweep owns the reap',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 retention sweep\'s capsules family age-prunes capsule files at 30 d (src/retention/sweep.ts:98) and listCapsules is capped newest-first at MAX_CAPSULES_LISTED 500 (src/context-map/capsule-persistence.ts:195,229) — the no-aggregate-prune gap behind the #2309 row is closed by the sweep.',
		},
	},
	{
		id: 'context-map',
		category: 8,
		pathGrammar: '.swarm/context-map.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/context-map/persistence.ts'],
		writerCitations: ['src/context-map/persistence.ts:132 saveContextMap — temp+rename (no lock)'],
		readerCitations: ['src/context-map/persistence.ts:92 loadContextMap — full-file'],
		schemaVersion: 'map schema',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten map derived from repository structure (rebuildable)', scope: 'global', citation: 'src/context-map/persistence.ts:92-133' },
		readBound: { pattern: 'full-file', bound: 'single derived map proportional to working set', sync: true, citation: 'src/context-map/persistence.ts:92' },
		lockModel: 'none (atomic rename)',
		crashBehavior: 'previous map intact; temp orphaned (residue scanner covers)',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'context-map.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'rebuildable',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single atomically-rewritten derived map with no append dimension (persistence.ts:132-133).' },
	},
	{
		id: 'curator-summary',
		category: 8,
		pathGrammar: '.swarm/curator-summary.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/curator.ts'],
		writerCitations: ['src/hooks/curator.ts:858 writeCuratorSummaryState — bunWrite atomic + cache invalidation :867; transactCuratorSummary :877-897'],
		readerCitations: ['src/hooks/curator.ts:907 readCuratorSummary — full-file; curator-postmortem.ts:1193 consumer'],
		schemaVersion: 'summary schema (recommendations array deduped + capped)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'single rewritten summary; embedded recommendations deduped/capped', scope: 'global', citation: 'src/hooks/curator.ts:858-897' },
		readBound: { pattern: 'indexed', bound: 'single JSON', sync: false, citation: 'src/hooks/curator.ts:907' },
		lockModel: 'transactFile directory lock',
		crashBehavior: 'atomic (temp+rename+fsync via bunWrite)',
		closePolicy: 'untouched',
		closeArrayMembership: {
			'curator-summary.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy spam capped in recommendations array',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single rewritten state file with capped embedded arrays (curator.ts:858-897).' },
	},
	{
		id: 'close-session-outputs',
		category: 8,
		pathGrammar: '.swarm/{close-summary.md, context.md, session-reflection.md, handoff.md, handoff-prompt.md, handoff-consumed.md, escalation-report.md, dark-matter.md, doc-manifest.json}',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/commands/close/clean-stage.ts',
			'src/commands/close/orchestrator.ts',
			'src/services/session-reflection.ts',
			'src/commands/handoff.ts',
			'src/hooks/agent-activity.ts',
			'src/hooks/phase-monitor.ts',
			'src/tools/doc-scan.ts',
			'src/hooks/full-auto-intercept.ts',
			'src/hooks/skill-propagation-gate.ts',
		],
		writerCitations: [
			'src/commands/close/orchestrator.ts close-summary (written AFTER clean, survives into next session); src/commands/close/clean-stage.ts context.md reset stub',
			'session-reflection.ts:1299 writeSessionReflection — fs.writeFile',
			'handoff.ts:53/63 — atomic handoff briefs',
			'agent-activity.ts:147 doFlush — context.md section rewrite (flush ≥20 events :107)',
		],
		readerCitations: ['system-enhancer + context-budget read handoff.md; agent-activity reads context.md before rewrite'],
		schemaVersion: 'markdown/json session documents',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'single rewritten session documents (close-summary/handoff atomic; context.md sectioned)', scope: 'session-scoped', citation: 'src/commands/close/constants.ts:16-195 (all but close-summary archived+cleaned)' },
		readBound: { pattern: 'full-file', bound: 'single documents', sync: false, citation: 'handoff.ts:45-46 consumers' },
		lockModel: 'atomic writes; snapshot in-flight serialization',
		crashBehavior: 'atomic rewrites; failures logged',
		closePolicy: 'archived+cleaned (close-summary.md deliberately written post-clean); context.md archived + rewritten to stub',
		closeArrayMembership: {
			'close-summary.md': 'archive-only',
			'context.md': 'archive-only',
			'session-reflection.md': 'archive+clean',
			'handoff.md': 'archive+clean',
			'handoff-prompt.md': 'archive+clean',
			'handoff-consumed.md': 'archive+clean',
			'escalation-report.md': 'archive+clean',
			'dark-matter.md': 'archive+clean',
			'doc-manifest.json': 'archive+clean',
		},
		resetPolicy: 'reset-session does not touch these; close does',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single-session documents with explicit archive/clean/stub semantics in the close lists themselves (src/commands/close/constants.ts:16-95; src/commands/close/clean-stage.ts:364-380; src/commands/close/orchestrator.ts:397-406).' },
	},
	{
		id: 'command-reports',
		category: 8,
		pathGrammar: '.swarm/simulate-report.{json,md} + .swarm/handoff-continuation.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/commands/simulate.ts', 'src/commands/handoff.ts'],
		writerCitations: ['src/commands/simulate.ts:77 — atomic single report; handoff.ts continuation pointer'],
		readerCitations: ['simulate-report: no production reader (operator artifact); handoff-continuation read on next-session resume'],
		schemaVersion: 'report schemas',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'single rewritten report files', scope: 'global', citation: 'src/commands/simulate.ts:77' },
		readBound: { pattern: 'indexed', bound: 'single files', sync: true, citation: 'as cited' },
		lockModel: 'atomic writes',
		crashBehavior: 'previous file intact',
		closePolicy: 'untouched (operator artifacts / continuation pointers)',
		closeArrayMembership: {
			'handoff-continuation.json': 'neither',
		},
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Single rewritten operator-facing report files (simulate.ts:77).' },
	},
	{
		id: 'project-init-configs',
		category: 8,
		pathGrammar: '.swarm/config.example.json + operator-authored .opencode/opencode-swarm.json (+ CLI-managed configs)',
		canonicalRoot: 'outside-swarm',
		writerModules: [
			'src/config/project-init.ts',
			'src/cli/index.ts',
			'src/utils/gitignore-warning.ts',
		],
		writerCitations: [
			'src/config/project-init.ts:25 writeSwarmConfigExampleIfNew (first-run .swarm/config.example.json write incl. $schema ref; errors non-fatal)',
			'src/cli/index.ts:289 saveJson — CLI-managed global/plugin config saves (outside .swarm)',
		],
		readerCitations: ['config loader; CLI loadJson (:269)'],
		schemaVersion: 'config schema',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: { bound: 'first-run example artifact + operator-edited config', scope: 'global', citation: 'src/config/project-init.ts:25-52' },
		readBound: { pattern: 'indexed', bound: 'single config files', sync: true, citation: 'src/cli/index.ts:269' },
		lockModel: 'exists-check-then-write init writes (single-threaded init; non-atomic, pre-existing)',
		crashBehavior: 'fail-open init writes',
		closePolicy: 'unaffected (outside close scope by design)',
		resetPolicy: 'operator-owned',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'First-run example artifact and operator-owned config files outside swarm runtime state (project-init.ts:25-52).' },
	},
	{
		id: 'bundled-skills',
		category: 8,
		pathGrammar: '.swarm/bundled-skills/{slug}/SKILL.md',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/config/bundled-skills.ts'],
		writerCitations: ['src/config/bundled-skills.ts — plugin-shipped protocol sync into BUNDLED_PROJECT_SKILL_ROOT (.swarm/bundled-skills, :56); registered-bespoke per #2035'],
		readerCitations: ['bundled-skill path helper (:60); architect MODE stub resolution'],
		schemaVersion: 'plugin-shipped skill content (fixed set)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'fixed slug set from BUNDLED_PROJECT_SKILLS (:6-50) — no growth dimension', scope: 'global', citation: 'src/config/bundled-skills.ts:6-56' },
		readBound: { pattern: 'indexed', bound: 'fixed set of small files', sync: false, citation: 'src/config/bundled-skills.ts:60' },
		lockModel: 'sync with coexistence/concurrency tests (invariant docs)',
		crashBehavior: 'fail-open sync',
		closePolicy: 'untouched (plugin-owned runtime root)',
		resetPolicy: 're-synced on init',
		legacyCompatibility: 'repository-native same-slug skills never overwritten (invariant 4 bundled-skill ownership)',
		healthSignal: 'drift-check bundled-skill completeness (issue #1496 class)',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Fixed plugin-owned slug set with drift-check completeness enforcement (bundled-skills.ts:6-56; drift-check.yml).' },
	},
	{
		id: 'skills-proposals',
		category: 8,
		pathGrammar: '.swarm/skills/proposals/{slug}.md + .swarm/skills/evals/{slug}/auto-stub.json + .swarm/skills/candidates/{uuid}.json',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/services/skill-generator.ts',
			'src/services/trajectory-cluster.ts',
			'src/services/external-skill-store.ts',
		],
		writerCitations: [
			'src/services/skill-generator.ts:834 generateSkills (atomic per proposal); :162 writeEvalStub; :1566 autoApplyProposals deletes rejected (unlinkSync)',
			'src/services/trajectory-cluster.ts:311,612 — motif/workflow proposals into skills/proposals',
		],
		readerCitations: ['skill-generator.ts:1213 activateProposal / :1618 inspectSkill; skill-evaluator.ts:190-303 loadEvalSet (≤50 files, ≤64 KiB)'],
		schemaVersion: 'proposal markdown + eval stub JSON',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'evals bounded (MAX_EVAL_FILES 50 / 64 KiB / 100 cases, skill-evaluator.ts:26-31); pending proposals age-pruned at 14 d by the retention sweep (src/retention/sweep.ts:100) — the documented pending-review expiry horizon; rejected ones still deleted on auto-apply',
			scope: 'per-key',
			keyspaceBound:
				'FINITE BY REAPER: the retention sweep\'s skills-proposals family age-prunes .swarm/skills/proposals/ at 14 d (src/retention/sweep.ts:100) — pending-review expiry is the global trigger that deletes proposal keys; rejected proposals continue to be deleted on auto-apply (src/services/skill-generator.ts:1566).',
			citation: 'src/services/skill-generator.ts:1566; src/services/skill-evaluator.ts:26-31; src/retention/sweep.ts:100',
		},
		readBound: { pattern: 'directory-scan', bound: 'eval loads capped; proposal listing bounded by the 14 d sweep horizon', sync: false, citation: 'src/services/skill-evaluator.ts:190-303' },
		lockModel: 'atomic writes; no cross-process lock',
		crashBehavior: 'atomic; temp orphans covered by residue scanner',
		closePolicy: 'untouched by close — the 14 d sweep owns pending-review expiry',
		resetPolicy: 'not reset',
		legacyCompatibility: 'stale/retired markers preserved in skill dirs',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Pending-proposal accumulation is closed by the #2483 retention sweep\'s skills-proposals family: 14 d age-prune (src/retention/sweep.ts:100) plus the existing rejected-on-auto-apply deletion (src/services/skill-generator.ts:1566); evals were already bounded (src/services/skill-evaluator.ts:26-31).',
		},
	},
	{
		id: 'skill-changelogs',
		category: 8,
		pathGrammar: '.swarm/skill-changelogs/{slug}.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/skill-changelog.ts'],
		writerCitations: ['src/services/skill-changelog.ts:137 appendSkillChangelog — appendCappedJsonl per-skill FIFO (MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL 200, :146-149) then enforceGlobalEntryCap on EVERY append (:77-80)'],
		readerCitations: ['src/services/skill-changelog.ts:162 readSkillChangelog — full-file per skill (each file ≤200 lines by the per-skill cap)'],
		schemaVersion: 'changelog entry schema',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL 200 FIFO per skill (crash-atomic trim) PLUS the GLOBAL entry ceiling MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES 10000 enforced on EVERY append with crash-atomic whole-file trims (:30,:77-136) — the former missing global ceiling was the #2309/#2038 verify item',
			scope: 'per-key',
			keyspaceBound:
				'≤ MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES slugs (10000) enforced on every append (src/services/skill-changelog.ts:79)',
			citation: 'src/services/skill-changelog.ts:14,30,79',
		},
		readBound: { pattern: 'full-file', bound: '≤200 lines per skill file', sync: true, citation: 'src/services/skill-changelog.ts:14,162' },
		lockModel: 'none (trim race possible, best-effort non-fatal)',
		crashBehavior: 'append atomic; global and per-skill trims are crash-atomic temp+rename',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'corrupt lines skipped',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The global-across-skills ceiling exists and is enforced on every append: MAX_SKILL_CHANGELOG_GLOBAL_ENTRIES 10000 total entries with crash-atomic per-file trims (enforceGlobalEntryCap, src/services/skill-changelog.ts:30,77-136), layered on the per-skill 200 FIFO (MAX_SKILL_CHANGELOG_ENTRIES_PER_SKILL, :14) — the #2309/#2038 verify item is closed by #2483 §2.',
		},
	},
	{
		id: 'skills-rejected-edits',
		category: 8,
		pathGrammar: '.swarm/skills/rejected-edits.jsonl',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/skill-evaluator.ts'],
		writerCitations: ['src/services/skill-evaluator.ts:537 appendRejectedSkillEdit — atomic rewrite with FIFO trim'],
		readerCitations: ['src/services/skill-evaluator.ts:549 isRejectedSkillContent — full-file exact+normalized hash check'],
		schemaVersion: 'record schema (preview ≤800 B)',
		stateClass: 'operational',
		privacyClass: 'content',
		writeLimits: { bound: 'MAX_REJECTED_EDIT_RECORDS 200 FIFO (:31-32)', scope: 'global', citation: 'src/services/skill-evaluator.ts:31-32' },
		readBound: { pattern: 'full-file', bound: '≤200 records', sync: true, citation: 'src/services/skill-evaluator.ts:31,549' },
		lockModel: 'none (trim best-effort)',
		crashBehavior: 'atomic rewrite',
		closePolicy: 'untouched',
		resetPolicy: 'not reset',
		legacyCompatibility: 'corrupt lines skipped',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Global FIFO 200 with bounded previews (skill-evaluator.ts:31-32).' },
	},
	{
		id: 'skill-improver-proposals',
		category: 8,
		pathGrammar: '.swarm/skill-improver/proposals/{timestamp}.md + .swarm/skill-improver/{consolidation-state.json} + .swarm/skill-improver-quota.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/skill-improver.ts', 'src/services/skill-improver-quota.ts', 'src/services/skill-consolidation.ts'],
		writerCitations: [
			'src/services/skill-improver.ts:725 runSkillImprover — atomic proposal per run, NO count cap',
			'src/services/skill-improver-quota.ts:115 writeState — dir-locked daily quota state (logical max_calls cap)',
			'src/services/skill-consolidation.ts:88 writeState — atomic single state file',
		],
		readerCitations: ['skill-generator.ts:1421-1430 listSkills proposal scan; quota readState :96'],
		schemaVersion: 'proposal/state schemas',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: {
			bound: 'quota + consolidation: single bounded state files (daily quota caps write rate); proposals age-pruned at 30 d by the retention sweep (src/retention/sweep.ts:101)',
			scope: 'global',
			citation: 'src/services/skill-improver.ts:725; src/retention/sweep.ts:101',
		},
		readBound: { pattern: 'directory-scan', bound: 'proposal listing bounded by the 30 d sweep horizon; states single files', sync: false, citation: 'skill-generator.ts:1421-1430' },
		lockModel: 'quota dir proper-lockfile (10 s timeout, 30 retries :40-58); consolidation in-memory dedup',
		crashBehavior: 'atomic writes; proposal failure returns ran:false',
		closePolicy: 'untouched by close — the 30 d sweep owns proposal expiry',
		closeArrayMembership: {
			'skill-improver-quota.json': 'neither',
		},
		resetPolicy: 'daily quota rollover re-initializes',
		legacyCompatibility: 'enrichment-quota variant path',
		healthSignal: 'quota pressure',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Proposal accumulation is closed by the #2483 retention sweep\'s skill-improver-proposals family (30 d age-prune, src/retention/sweep.ts:101); the daily quota remains a rate bound and the two state files are single rewritten artifacts (src/services/skill-improver-quota.ts:115; src/services/skill-consolidation.ts:88).',
		},
	},
	{
		id: 'skill-optimizer-evolution',
		category: 8,
		pathGrammar: '.swarm/evolution/skills/{slug}/{candidateId}/{lifecycle.jsonl, state.json, baseline.md, candidate.md, rollback.md, diff.patch} + .convergence.json + lifecycle-quarantine.* + _eval-input/**',
		canonicalRoot: 'project-swarm',
		writerModules: [
			'src/services/skill-optimizer/store.ts',
			'src/services/skill-optimizer/activation.ts',
			'src/services/skill-optimizer/controller.ts',
			'src/services/skill-optimizer/skill-eval-tasks.ts',
			'src/commands/skill-opt.ts',
		],
		writerCitations: [
			'src/services/skill-optimizer/store.ts:349 appendEvent — fsynced locked append, hash-chained, NEVER rewritten; :475 quarantineSuffix; :504 writeStateProjection; :523 writeArtifact',
			'src/services/skill-optimizer/controller.ts:677 writeConvergenceState — plain writeFileSync; :158,163 candidate payloads into inputRoot',
			'src/services/skill-optimizer/activation.ts:129 rollback.md before activation; skill-eval-tasks.ts:96-112 fixture files',
			'src/commands/skill-opt.ts:231 — copyFileSync materializes .swarm/evolution/skills/_eval-input/scoring/*.cjs (final-critic-found writer; copy-materialization seam)',
		],
		readerCitations: ['store.ts:411 replayCandidate — full replay, stops at first bad line (truncated flagged)'],
		schemaVersion: 'hash-chained ledger + derived projection',
		stateClass: 'authoritative',
		privacyClass: 'content',
		directFileExemption: {
			reason: 'Hash-chained per-candidate lifecycle ledgers are authoritative and never rewritten (rollback artifacts are required for activation rollback); the #2483 terminal-candidate sweep (terminal+30 d, 90 d age-only backstop) bounds the candidate keyspace without touching live ledgers.',
			reviewedIssue: 2483,
		},
		writeLimits: {
			bound: 'per-candidate ledgers are hash-chained append-only authorities (never rewritten); the retention sweep prunes TERMINAL candidates at 30 d with a 90 d age-only backstop (EVOLUTION_BACKSTOP_AGE_DAYS, src/retention/sweep.ts:45,301-302), plus _eval-input scratch at 7 d and lifecycle-quarantine sidecars at 30 d (src/retention/sweep.ts:227-229)',
			scope: 'global',
			citation: 'src/retention/sweep.ts:45,301',
		},
		readBound: { pattern: 'full-file', bound: 'per-candidate ledger replay (full replay per candidate; the candidate population is bounded by the terminal-candidate sweep)', sync: true, citation: 'src/services/skill-optimizer/store.ts:411-430' },
		lockModel: 'withEvidenceLock per ledger path',
		crashBehavior: 'fsync+rename; torn tail quarantined with suffix capture; projection re-derived',
		closePolicy: 'untouched by close — the terminal-candidate sweep owns the keyspace (terminal+30 d / 90 d backstop)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'candidate rollback artifacts required for activation rollback',
		healthSignal: 'truncated flag',
		owner: '#2483 (terminal-candidate sweep + exemption review)',
		disposition: {
			kind: 'retain-by-design',
			citation:
				'Hash-chained per-candidate authority: the lifecycle ledger is append-only by integrity requirement (rollback.md/baseline.md artifacts are required for activation rollback — src/services/skill-optimizer/store.ts:349,411-430), so no compaction may rewrite a live ledger; the #2483 sweep bounds the keyspace instead — terminal candidates pruned at 30 d with the 90 d EVOLUTION_BACKSTOP_AGE_DAYS age-only backstop (src/retention/sweep.ts:45,301-302), plus _eval-input (7 d) and lifecycle-quarantine (30 d) scratch expiry (src/retention/sweep.ts:227-229).',
		},
	},
	{
		id: 'outside-swarm-tool-outputs',
		category: 8,
		pathGrammar: '.mutation_patch_{id}.diff (workdir) + extract_code_blocks outputs (user dir) + revised/generated skills (.opencode/skills) + apply-patch temps (finally-cleaned)',
		canonicalRoot: 'outside-swarm',
		writerModules: [
			'src/mutation/engine.ts',
			'src/tools/file-extractor.ts',
			'src/services/skill-reviser.ts',
			'src/tools/apply-patch.ts',
			'src/sandbox/macos/sandbox-exec-executor.ts',
			'src/sandbox/win32/native-sandbox-executor.ts',
			'src/tools/external-skill-promote.ts',
		],
		writerCitations: [
			'src/mutation/engine.ts:299 — patch file per mutation run (working directory, batch-scoped)',
			'src/tools/file-extractor.ts:111-126 — O_EXCL user-directed outputs with rollback (:15-51)',
			'src/services/skill-reviser.ts:246,356 — skill-path temp+rename (external destination, #2035-classified)',
			'src/tools/apply-patch.ts:770 — temp cleaned in finally (:774-780)',
		],
		readerCitations: ['write-only / consumed by the invoking workflow'],
		schemaVersion: 'n/a',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'batch-scoped or user-directed outputs outside swarm state; apply-patch temps always cleaned', scope: 'per-trigger', citation: 'src/tools/apply-patch.ts:774-780; file-extractor.ts:15-51' },
		readBound: { pattern: 'write-only', bound: 'n/a', sync: true, citation: 'as cited' },
		lockModel: 'O_EXCL where collision matters',
		crashBehavior: 'rollback paths remove created files',
		closePolicy: 'outside .swarm — out of swarm retention scope by definition (recorded for enumeration completeness)',
		resetPolicy: 'operator-owned',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Outputs outside swarm runtime state: batch-scoped patch files, O_EXCL user-directed extractions with rollback, finally-cleaned temps (apply-patch.ts:774-780).' },
	},

	{
		id: 'drift-reports',
		category: 3,
		pathGrammar:
			'swarm.db table phase_report kind=curator_drift (issue #2480; legacy .swarm/drift-report-phase-{N}.json imported once then cold-archived .json.imported)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/db/phase-report-store.ts', 'src/hooks/curator-drift.ts'],
		writerCitations: [
			'src/db/phase-report-store.ts upsertPhaseReportDb — group-commit writer, one BEGIN IMMEDIATE txn per flush, PK(kind, phase) upsert',
			'src/hooks/curator-drift.ts writeDriftReport — delegates to the store; same-phase rerun overwrites',
		],
		readerCitations: [
			'src/hooks/curator-drift.ts readPriorDriftReports — ordered per-phase SELECT with skip-corrupt schema validation',
			'src/hooks/curator-postmortem.ts collectDriftReports — last MAX_DRIFT_REPORTS reports as context',
		],
		schemaVersion: 'per-phase report schema (schema_version 1)',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'one row per phase (PK kind,phase; last-write-wins); legacy files archived+cleaned as close dynamic artifacts when present', scope: 'session-scoped', citation: 'src/db/phase-report-store.ts; src/commands/close.ts dynamic drift-report regex (retained for legacy files)' },
		readBound: { pattern: 'indexed', bound: 'ordered per-phase rows via PK', sync: true, citation: 'src/hooks/curator-drift.ts readPriorDriftReports' },
		lockModel: 'SQLite WAL + busy_timeout 5000 + BEGIN IMMEDIATE write txns',
		crashBehavior: 'WAL auto-recovery; unflushed queue ops lost (awaited flush preserves the legacy write durability)',
		closePolicy: 'rows live in swarm.db (archived+cleaned by the project-db row); legacy drift-report-phase-*.json files that reappear are still archived+cleaned by the close dynamic regex',
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy files imported once (one-txn, per-kind empty guard) then renamed .json.imported; corrupt files skipped and counted',
		healthSignal: 'n/a',
		owner: 'this-gate',
		disposition: { kind: 'not-a-defect', proof: 'Session-scoped per-phase reports, one row per phase with verified close lifecycle for both the swarm.db rows (project-db row) and any legacy files (close.ts dynamic regex).' },
	},
	{
		id: 'doc-drift-signals',
		category: 3,
		pathGrammar:
			'swarm.db table phase_report kind=design_doc_drift (issue #2480; legacy .swarm/doc-drift-phase-{N}.json imported once then cold-archived .json.imported)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/db/phase-report-store.ts', 'src/hooks/design-doc-drift.ts'],
		writerCitations: [
			'src/db/phase-report-store.ts upsertPhaseReportDb — group-commit writer, one BEGIN IMMEDIATE txn per flush, PK(kind, phase) upsert (replaces the legacy bare non-atomic writeFile)',
			'src/hooks/design-doc-drift.ts runDesignDocDriftCheck — delegates the persist step to the store',
		],
		readerCitations: ['design-doc drift gate reads the current phase signal (readPhaseReportsDb)'],
		schemaVersion: 'phase drift signal schema (schema_version 1)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: {
			bound: 'one row per phase (PK kind,phase; last-write-wins) inside swarm.db; legacy doc-drift-phase-*.json.imported cold archives swept at 30 d (src/retention/sweep.ts:185-200)',
			scope: 'global',
			citation: 'src/db/phase-report-store.ts; src/retention/sweep.ts:189',
		},
		readBound: { pattern: 'indexed', bound: 'per-phase small JSON rows via PK', sync: true, citation: 'src/db/phase-report-store.ts readPhaseReportsDb' },
		lockModel: 'SQLite WAL + busy_timeout 5000 + BEGIN IMMEDIATE write txns',
		crashBehavior: 'WAL auto-recovery; awaited flush preserves durability',
		closePolicy: 'untouched — accumulates in swarm.db (swarm.db itself archived+cleaned by the project-db row)',
		resetPolicy: 'not reset',
		legacyCompatibility: 'legacy files imported once (one-txn, per-kind empty guard) then renamed .json.imported',
		healthSignal: 'doc-drift gate state',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Migrated to per-phase swarm.db rows (issue #2480) with no accumulating file stream left: the #2483 sweep expires legacy doc-drift-phase-*.json.imported cold archives at 30 d (src/retention/sweep.ts:185-200), and the swarm.db rows themselves ride the project-db close lifecycle.',
		},
	},
	{
		id: 'review-receipts',
		category: 4,
		pathGrammar: '.swarm/review-receipts/{YYYY-MM-DD}-{id}.json + index.json',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/hooks/review-receipt.ts'],
		writerCitations: [
			'src/hooks/review-receipt.ts — one file per receipt + index manifest (:14-15); registered-bespoke temp grammar (#2035); writes persistReviewReceipt :662, removeReviewReceipt :728, updateReviewReceiptValidations :766',
		],
		readerCitations: ['manifest-based lookup (index.json) for receipt verification; readAllReceipts newest-first capped at MAX_RECEIPTS_READ 1000 (:904,:915-917)'],
		schemaVersion: 'receipt schema + index manifest',
		stateClass: 'governed-content',
		privacyClass: 'mixed',
		writeLimits: {
			bound: 'one small file per review receipt; the retention sweep\'s review-receipts family age-prunes at 30 d + keeps newest 1000 (REVIEW_RECEIPTS_KEEP_NEWEST, src/retention/sweep.ts:49,96) — index entries whose files were pruned resolve to null fail-open on lookup (parseReceiptFromIndexEntry); the index read is capped at MAX_RECEIPTS_READ 1000 newest-first (src/hooks/review-receipt.ts:904)',
			scope: 'global',
			citation: 'src/retention/sweep.ts:49,96; src/hooks/review-receipt.ts:904',
		},
		readBound: { pattern: 'indexed', bound: 'manifest lookup + per-file reads; index read ≤1000 newest entries', sync: false, citation: 'src/hooks/review-receipt.ts:911' },
		lockModel: 'registered-bespoke atomic writes (#2035)',
		crashBehavior: 'atomic; manifest rebuildable from files',
		closePolicy: 'untouched by close — the 30 d / newest-1000 sweep owns the reap',
		resetPolicy: 'not reset',
		legacyCompatibility: 'n/a',
		healthSignal: 'n/a',
		owner: '#2483',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'The #2483 retention sweep\'s review-receipts family age-prunes receipts at 30 d with a keep-newest-1000 cap (REVIEW_RECEIPTS_KEEP_NEWEST, src/retention/sweep.ts:49,96); index entries whose files were pruned resolve to null fail-open (parseReceiptFromIndexEntry, src/hooks/review-receipt.ts:849) and the index reader is capped at MAX_RECEIPTS_READ 1000 newest-first (:904,915) — the accumulation gap behind the #2309 row is closed by the sweep.',
		},
	},
	{
		id: 'residue-quarantine',
		category: 8,
		pathGrammar: '.swarm/quarantine/{batch}/ (+ per-batch manifest with sha256/original-path/reason)',
		canonicalRoot: 'project-swarm',
		writerModules: ['src/services/swarm-residue.ts'],
		writerCitations: [
			'src/services/swarm-residue.ts:541 — atomicWriteSwarmFileSync quarantine moves with manifest (issue #2035); rollback via /swarm config doctor --rollback-residue-quarantine',
		],
		readerCitations: ['doctor/close dry-run residue inventory; rollback reads manifests'],
		schemaVersion: 'quarantine manifest schema (#2035)',
		stateClass: 'governed-content',
		privacyClass: 'metadata',
		writeLimits: { bound: 'bounded by verified stale-residue discovery (old, unlocked, untracked, exact-grammar matches only — #2035 eligibility rules)', scope: 'per-trigger', citation: 'src/services/swarm-residue.ts (issue #2035 implementation)' },
		readBound: { pattern: 'indexed', bound: 'manifest-driven reads', sync: true, citation: 'src/services/swarm-residue.ts:541' },
		lockModel: 'atomic moves guarded per entry',
		crashBehavior: 'per-entry guarded moves; honest partial-outcome reporting',
		closePolicy: 'untouched — recoverable quarantine is preserved across close by design (rollback must remain available)',
		resetPolicy: 'operator rollback deletes with manifest verification',
		legacyCompatibility: 'n/a',
		healthSignal: 'residue_health telemetry (counts only)',
		owner: '#2035 (merged)',
		disposition: {
			kind: 'retain-by-design',
			citation: '#2035 quarantine contract: quarantine is deliberately recoverable preservation, never deletion; manifest-backed with idempotent rollback; eligibility (≥30 min old, untracked, unlocked, non-symlink, exact grammar) bounds intake.',
		},
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Category 9 — planned streams (PRs 19–23); no current implementation
	// ─────────────────────────────────────────────────────────────────────────
	{
		id: 'planned-observability-sink',
		category: 9,
		pathGrammar:
			'swarm.db table observability_event (issue #2482 — the planned .swarm/observability/v1/ segment surface was superseded by the merged SQLite sink; the real surface is owned end-to-end by the observability-events-sqlite row)',
		canonicalRoot: 'planned',
		writerModules: [],
		writerCitations: ['no separate implementation — the #2047 segment design was superseded by the merged #2482 sink (src/db/observability-event-store.ts), registered on the observability-events-sqlite row (no duplicate writer registration)'],
		readerCitations: ['src/db/observability-event-store.ts queryObservabilityEvents — the real /swarm report reader'],
		schemaVersion: 'v1 per #2047 design (superseded by the #2482 envelope-row schema)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'superseded by #2482: MAX_OBSERVABILITY_EVENT_ROWS 50000 global DELETE-oldest + 16 KiB per-payload cap (src/db/observability-event-store.ts, owned by the observability-events-sqlite row)', scope: 'global', citation: 'src/db/observability-event-store.ts' },
		readBound: { pattern: 'indexed', bound: 'superseded by #2482: deterministic indexed SELECTs with report LIMIT 5000', sync: false, citation: 'src/db/observability-event-store.ts' },
		lockModel: 'planned: cross-process safe rotation (superseded by SQLite WAL + group-commit)',
		crashBehavior: 'planned: deterministic segment recovery (superseded by WAL auto-recovery + in-table quarantine)',
		closePolicy: 'superseded by #2482: rows live in swarm.db (archived+cleaned by the project-db row)',
		resetPolicy: 'planned',
		legacyCompatibility: 'legacy streams migrate per #2487',
		healthSignal: 'planned loss/coverage health (superseded by observability_sink_health counters)',
		owner: '#2482 (superseding implementation); #2047 (original plan)',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Superseded by the merged #2482 SQLite observability sink: the planned .swarm/observability/v1/ segment surface was never implemented — the real surface is swarm.db table observability_event with a 50000-row global DELETE retention and 16 KiB per-payload cap (src/db/observability-event-store.ts), owned end-to-end by the observability-events-sqlite row; this row records the supersession (no duplicate row, no unregistered writer).',
		},
	},
	{
		id: 'planned-rebuildable-index',
		category: 9,
		pathGrammar:
			'swarm.db table observability_event idx_obs_event_* indexes (issue #2482 — the planned separate derived index was superseded by in-table indexes + /swarm report, owned by the observability-events-sqlite row)',
		canonicalRoot: 'planned',
		writerModules: [],
		writerCitations: ['no separate implementation — the #2048 derived-index design was superseded by the merged #2482 in-table indexes (src/db/observability-event-store.ts), registered on the observability-events-sqlite row (no duplicate writer registration)'],
		readerCitations: ['src/commands/report.ts handleReportCommand — the real /swarm report consumer'],
		schemaVersion: 'index schema per #2048 (superseded by the #2482 in-table indexes)',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'superseded by #2482: indexed columns on a 50000-row-retention table (src/db/observability-event-store.ts, owned by the observability-events-sqlite row)', scope: 'global', citation: 'src/db/observability-event-store.ts' },
		readBound: { pattern: 'indexed', bound: 'superseded by #2482: indexed-column lookups with report queries LIMIT 5000', sync: true, citation: 'src/db/observability-event-store.ts' },
		lockModel: 'planned',
		crashBehavior: 'planned: corrupt index rebuilds from segments (superseded: the index IS the table)',
		closePolicy: 'superseded by #2482: never authoritative — rows live in swarm.db (project-db row lifecycle)',
		resetPolicy: 'rebuildable by deletion',
		legacyCompatibility: 'n/a',
		healthSignal: 'planned coverage metrics (superseded by observability_sink_health counters)',
		owner: '#2482 (superseding implementation); #2048 (original plan)',
		disposition: {
			kind: 'not-a-defect',
			proof:
				'Superseded by the merged #2482 SQLite observability sink: the planned separate derived index was never implemented — the real surface is the in-table idx_obs_event_* indexes with LIMIT-bounded report queries (src/db/observability-event-store.ts), owned end-to-end by the observability-events-sqlite row; this row records the supersession (no duplicate row, no unregistered writer).',
		},
	},
	{
		id: 'planned-otlp-export',
		category: 9,
		pathGrammar: 'planned bounded export queue/spool (opt-in)',
		canonicalRoot: 'planned',
		writerModules: [],
		writerCitations: ['no current implementation (no OTLP adapter — verified per #2049 Observed)'],
		readerCitations: ['collector export planned (#2049)'],
		schemaVersion: 'pinned mapping versions (#2029 §9)',
		stateClass: 'operational',
		privacyClass: 'metadata',
		writeLimits: { bound: 'planned: bounded queue/spool with independent failure health (#2049 Required)', scope: 'global', citation: 'issue #2049' },
		readBound: { pattern: 'indexed', bound: 'planned bounded drain', sync: false, citation: 'issue #2049' },
		lockModel: 'planned',
		crashBehavior: 'planned: local operation never depends on collector',
		closePolicy: 'planned',
		resetPolicy: 'planned',
		legacyCompatibility: 'n/a',
		healthSignal: 'planned queue-exhaustion health',
		owner: '#2485',
		disposition: { kind: 'fix-in-issue', issue: 2485, note: 'The optional OTLP/OpenInference exporter is re-pointed from the closed #2049 sequence slot to open follow-up #2485 (roadmap re-baseline; #2483 re-disposition).' },
	},
	{
		id: 'planned-training-vault',
		category: 9,
		pathGrammar: 'planned consented training vault + derivatives + dataset exports',
		canonicalRoot: 'planned',
		writerModules: [],
		writerCitations: ['no current implementation (no src/training subsystem — verified per #2050 Observed)'],
		readerCitations: ['/swarm dataset export planned (#2050)'],
		schemaVersion: 'consent/lineage manifests per #2050',
		stateClass: 'governed-content',
		privacyClass: 'content',
		writeLimits: { bound: 'planned: quotas/expiry/withdrawal; content OFF by default, human-only consent (#2050 Trust and storage contract)', scope: 'global', citation: 'issue #2050' },
		readBound: { pattern: 'indexed', bound: 'planned authorized reads only', sync: false, citation: 'issue #2050' },
		lockModel: 'planned',
		crashBehavior: 'planned',
		closePolicy: 'planned: withdrawal removes lineage-tracked content',
		resetPolicy: 'planned: consent revocation',
		legacyCompatibility: 'n/a',
		healthSignal: 'planned consent/quota health',
		owner: '#2486',
		disposition: { kind: 'fix-in-issue', issue: 2486, note: 'The governed training vault and dataset export are re-pointed from the closed #2050 sequence slot to open follow-up #2486 (roadmap re-baseline; #2483 re-disposition).' },
	},
	{
		id: 'planned-legacy-retirement',
		category: 9,
		pathGrammar: 'legacy stream retirement map (telemetry.jsonl, knowledge-application, events readers per PRs 09-14 outcomes)',
		canonicalRoot: 'planned',
		writerModules: [],
		writerCitations: ['migration matrix built from this registry (#2051 Required 1)'],
		readerCitations: ['parity/coverage proofs planned (#2051)'],
		schemaVersion: 'n/a',
		stateClass: 'derived-rebuildable',
		privacyClass: 'metadata',
		writeLimits: { bound: 'planned: controlled dual-write/read shadowing with kill switches', scope: 'global', citation: 'issue #2051' },
		readBound: { pattern: 'indexed', bound: 'planned parity comparisons', sync: false, citation: 'issue #2051' },
		lockModel: 'planned',
		crashBehavior: 'planned: reversible kill switches',
		closePolicy: 'planned: archived-session compatibility',
		resetPolicy: 'planned',
		legacyCompatibility: 'IS the legacy compatibility program',
		healthSignal: 'planned parity budgets',
		owner: '#2487',
		disposition: { kind: 'fix-in-issue', issue: 2487, note: 'Shadow rollout, parity proofs, and source-proven retirement of each legacy path are re-pointed from the closed #2051 sequence slot to open follow-up #2487 (roadmap re-baseline; #2483 re-disposition) — still the recorded migration owner for telemetry.jsonl and knowledge-application.jsonl.' },
	},
];

/**
 * Issue #1534 guardrail — FROZEN allowlist. Artifacts already wired into
 * close.ts's `ARCHIVE_ARTIFACTS` / `ACTIVE_STATE_TO_CLEAN` on the day the
 * close-lifecycle coherence gate landed, for which no registry row names the
 * file. These are NOT the #1534 defect class: their close lifecycle IS wired
 * (that is why they appear in the arrays at all) — they are a pre-existing
 * registry-GRANULARITY gap, recorded rather than silently tolerated.
 *
 * This list may only SHRINK. A newly added close.ts artifact must be declared
 * in some row's `closeArrayMembership`; adding it here instead re-opens
 * exactly the hole the gate exists to close.
 * `tests/unit/scripts/check-retention-close-lifecycle.test.ts` pins its
 * contents so growth is a test failure, not a silent edit.
 */
export const CLOSE_ARTIFACTS_WITHOUT_REGISTRY_ROW: readonly string[] =
	Object.freeze([
		// Written by src/commands/close.ts itself (close-lessons harvest) and read
		// back by src/commands/registry.ts; archived, never cleaned. Recommendation:
		// give it a row under a future observability-registry pass.
		'close-lessons.md',
	]);

/**
 * Issue #1534 guardrail — FROZEN, and EMPTY by design. Flat `.swarm/` SQLite
 * artifacts permitted to declare a `closeArrayMembership` other than
 * `archive+clean`.
 *
 * Without this rule an author could reintroduce sub-defect (a) verbatim by
 * declaring a new `.swarm/*.sqlite` as `neither`: the declaration would match
 * close.ts (which indeed does nothing with it), and the VACUUM-INTO and
 * handle-close rules would never fire because they key on real array
 * membership. A WAL-mode database left on disk across `/swarm close` is the
 * exact orphaning #1534 was about, so the honest way to have one is an entry
 * here with a reason — reviewed — not a quiet `neither`.
 *
 * Empty today: `.swarm/` holds exactly two SQLite artifacts, `swarm.db` and
 * `repo-memory.sqlite`, and both are `archive+clean`.
 * (`.swarm/memory/memory.db` is not a flat `.swarm/` file and is out of scope.)
 */
export const SQLITE_ARTIFACTS_EXEMPT_FROM_ARCHIVE_CLEAN: Readonly<
	Record<string, string>
> = Object.freeze({});

/**
 * Issue #1534 guardrail. `project-swarm` rows whose `pathGrammar` legitimately
 * does NOT begin with `.swarm/` because the root is indirected through a
 * configurable store location. Without this closed list, a future author could
 * dodge the `closeArrayMembership` requirement by writing a prose-y
 * `pathGrammar` that names no `.swarm/<file>` token.
 */
export const PROJECT_SWARM_ROWS_WITH_INDIRECT_ROOT: readonly string[] =
	Object.freeze([
		'recommendation-ledger',
		'curation-proposals',
		// issue #2480: swarm.db table rows — the physical artifact (swarm.db) is
		// owned and lifecycle-declared by the project-db row; these rows own the
		// logical tables and the cold-archived legacy files inside them.
		'insight-candidates',
		// issue #2482: same indirection — observability tables inside swarm.db;
		// the legacy telemetry.jsonl stays live (owned by telemetry-jsonl) and
		// is imported incrementally, never renamed.
		'observability-events-sqlite',
		'drift-reports',
		'doc-drift-signals',
	]);

/**
 * Modules that physically contain write calls but own NO durable stream:
 * they are plumbing executing on behalf of row-owning caller modules. The
 * coverage ratchet accepts a module only here (with a reason) or in some
 * row's writerModules — never silently.
 */
export const EXEMPT_WRITER_MODULES: Readonly<Record<string, string>> = Object.freeze({
	'src/utils/atomic-write.ts': 'canonical atomic-write helper — callers own the streams (issue #2035)',
	'src/pr-review/persistence.ts': 'PR-review workflow-state persistence plumbing (issue #2385) — the only durable stream this module writes is the gate-state file .swarm/pr-workflow-gates/*.json via writeStateWhileLocked; that stream is currently UNREGISTERED in this data set (F-PRR-013 — separate follow-up row needed); until then the gate-state writes are exempt plumbing',
	'src/utils/bun-compat.ts': 'bunWrite Node-fallback helper — callers own the streams',
	'src/evidence/task-file.ts': 'atomic-write adapter for evidence/{taskId}.json — rows task-workflow-evidence/council-evidence-files own the stream',
	'src/evidence/immutable-store.ts': 'writeImmutableArtifact executes on behalf of the evaluation-store row owners',
	'src/workflow/workflow-wal-file.ts': 'WAL write helper — the workflow-wal-dirs row owns the streams',
	'src/db/sqlite-loader.ts': 'bun:sqlite/node:sqlite loader (issue #1873) — DB rows own the streams',
	'src/memory/jsonl-migration.ts': 'legacy JSONL→SQLite migration executor — memory-sqlite row owns the destination',
	'src/retention/jsonl-cap.ts': 'shared retention plumbing (appendCappedJsonl/readTailJsonl, issue #2483 §1) — callers own the streams; their rows carry the cap citations',
});

/** Sequence window for fix-in-issue dispositions (issue #2036 amendment clause). */
/** Schema version of the registry data structure itself (not per-row stream schemas). */
export const RETENTION_REGISTRY_SCHEMA_VERSION = 1;

export const RETENTION_ISSUE_SEQUENCE = {
	first: 2029,
	last: 2051,
	/**
	 * Sequence-amendment issues opened under #2036's amendment clause (residual
	 * unowned streams). Append new amendment issue numbers here as they are
	 * opened — the check validates fix-in-issue against this list.
	 *
	 * #2483 note: #2309's scope was CLOSED by #2483 (every #2309 row is
	 * re-dispositioned there; the checker's RESOLVED_SCOPE_ISSUES rung rejects
	 * any NEW fix-in-issue naming it). #2483 itself is deliberately NOT an
	 * amendment — its registry work landed, not deferred. #2485/#2486/#2487 are
	 * the open roadmap follow-ups that inherited the planned OTLP-export,
	 * training-vault, and legacy-retirement rows from the closed #2049/#2050/
	 * #2051 sequence slots.
	 */
	amendments: [2309, 2485, 2486, 2487] as readonly number[],
} as const;

export function getRetentionRow(id: string): RetentionRow | undefined {
	return RETENTION_REGISTRY.find((row) => row.id === id);
}

export function listRetentionWriterModules(): string[] {
	const modules = new Set<string>();
	for (const row of RETENTION_REGISTRY) {
		for (const m of row.writerModules) modules.add(m);
	}
	for (const m of Object.keys(EXEMPT_WRITER_MODULES)) modules.add(m);
	return [...modules].sort();
}

export const DISPOSITION_FORBIDDEN_STRINGS = [
	'TBD',
	// 'defer' matches both 'defer' and 'deferred' (substring scan)
	'defer',
	'unknown',
	'future issue',
] as const;

export const RETENTION_REGISTRY_SUMMARY = {
	rowCount: RETENTION_REGISTRY.length,
	writerModuleCount: listRetentionWriterModules().length,
	fixInIssue: RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'fix-in-issue').length,
	retainByDesign: RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'retain-by-design').length,
	notADefect: RETENTION_REGISTRY.filter((r) => r.disposition.kind === 'not-a-defect').length,
} as const;
