/**
 * Canonical atomic-write helper + temp-grammar registry (issue #2035).
 *
 * Single source of truth for:
 *  - HOW production code atomically writes files under the project `.swarm/`
 *    root: one same-directory write-temp→fsync→rename helper with exact
 *    `finally` cleanup of its OWN temp only.
 *  - WHAT temporary-file name grammars exist: a frozen registry derived from
 *    the writer census so residue scanners classify candidates by exact
 *    registered grammars instead of substring guesses.
 *
 * Why the registry lives here: every residue consumer (close clean stage,
 * close dry-run, config doctor, diagnose, quarantine/rollback in
 * `src/services/swarm-residue.ts`) must derive candidates from the SAME
 * registered grammars, and every atomic writer must be classifiable against
 * the same table (see `WRITER_CLASSIFICATION` and its ratchet test).
 *
 * Containment contract (issue #2035 req 1): the canonical target must live
 * under a `.swarm/` root, determined by SPELLING — the nearest `.swarm` path
 * segment between the filesystem root and the target. A pre-existing root
 * must be a real directory (no symlinks), and no path segment between it and
 * the target may be a symlink. Semantics are validateSwarmPath-INSPIRED but
 * NOT identical — see the junction limitation on
 * `assertSwarmContainedTarget`.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidateCachedArtifact } from './swarm-artifact-cache';

// ─────────────────────────────────────────────────────────────────────────────
// Temp-grammar registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A registered temporary-file naming grammar.
 *
 * `match` is applied to the temp file's BASENAME only, case-sensitively —
 * near-misses (unicode/case variants, trailing dots, ADS suffixes) must NOT
 * match, so they are preserved untouched by every scanner.
 */
export interface SwarmTempGrammar {
	/** Stable id used in reports, manifests, and telemetry (never renamed). */
	readonly id: string;
	readonly era: 'canonical' | 'current' | 'legacy';
	/** Matches the temp basename. Capture group 1 = derivable target basename when `parsesTarget`. */
	readonly match: RegExp;
	/** The grammar embeds a per-invocation uniqueness token (ts/pid/uuid/random). */
	readonly token: 'instance' | 'constant';
	/** Trusted for quarantine when all eligibility gates pass (issue #2035 req 5). */
	readonly quarantineEligible: boolean;
	/** Whether a target basename can be parsed back out of the temp name. */
	readonly parsesTarget: boolean;
	/** Producing writer sites (file:line) — every known producer is listed. */
	readonly producers: readonly string[];
	/** Invariant reason the producer is NOT migrated to the canonical helper. */
	readonly note?: string;
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Every temp grammar a swarm writer has ever produced. Grammars marked
 * `quarantineEligible: false` are constant-name temps: with no per-invocation
 * token they are indistinguishable from an in-flight writer of ANY process or
 * from an unrelated file, so scanners report them but never mutate them.
 * ORDER MATTERS: `matchTempGrammar`/`parseTargetBasename` take the FIRST
 * match, so more-specific grammars (uuid, two-token, .json-terminated) must
 * be declared before the generic single-token family.
 */
export const SWARM_TEMP_GRAMMARS: readonly SwarmTempGrammar[] = [
	{
		id: 'canonical-v1',
		era: 'canonical',
		match: /^(.+)\.[0-9a-f]{32}\.tmp$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/utils/atomic-write.ts:atomicWriteSwarmFile',
			// The any-root variant shares the same writeAtomicSync core and
			// emits the identical grammar (PR review PRR-018):
			'src/utils/atomic-write.ts:atomicWriteFileAnyRoot',
		],
	},
	{
		id: 'target-suffix-tmp-uuid',
		era: 'current',
		match: new RegExp(`^(.+)\\.tmp\\.${UUID_RE}$`),
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/commands/handoff.ts:48 (pre-#2035)',
			'src/commands/handoff.ts:79 (pre-#2035)',
			'src/memory/local-jsonl-provider.ts:1288',
			'src/config/bundled-skills.ts:250',
		],
	},
	{
		id: 'target-suffix-tmp-pid-uuid',
		era: 'current',
		match: new RegExp(`^(.+)\\.tmp\\.\\d+\\.${UUID_RE}$`),
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/hooks/pr-workflow-gate.ts (pre-#2385; migration extracted to src/pr-review/persistence.ts)',
		],
		note: 'pre/post-rename file-identity verification (assertOpened/ClosedSwarmFileIdentity, pr-workflow-gate.ts:17880-17980) is writer-specific and load-bearing',
	},
	{
		id: 'target-suffix-tmp-num-num-json',
		era: 'current',
		match: /^(.+)\.tmp\.\d+\.\d+\.json$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: ['src/hooks/issue-trace-state.ts:315'],
		note: 'the .json terminator keeps this shape distinct from the bare two-token family — declared before it so first-match wins',
	},
	{
		id: 'target-suffix-tmp-num-alnum',
		era: 'current',
		match: /^(.+)\.tmp\.\d+\.[0-9a-z]+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/evidence/task-file.ts:67 (pre-#2035)',
			'src/scope/scope-persistence.ts:2304 (pre-#2035)',
			'src/scope/scope-persistence.ts:2318 (pre-#2035)',
			'src/plan/manager.ts:629',
			'src/plan/manager.ts:1785',
			'src/plan/manager.ts:1831',
			'src/review/evidence.ts:175',
			'src/turbo/lean/evidence.ts:182',
			'src/summaries/manager.ts:122',
			'src/evidence/manager.ts:288',
			'src/evidence/manager.ts:456',
			'src/tools/sast-baseline.ts:199',
			'src/tools/repo-graph/storage.ts:493',
			'src/memory/reflection-service.ts:547 (pre-#2035)',
			'src/hooks/review-receipt.ts:608',
			'src/hooks/review-receipt.ts:674',
			'src/hooks/review-receipt.ts:812',
			'src/knowledge/identity.ts:209',
			'src/evidence/phase-participation.ts:303 (pre-#2035)',
			'src/turbo/lean/integration.ts:426',
			'src/turbo/lean/reviewer.ts:403',
			'src/plan/ledger.ts:737',
			'src/services/synonym-map.ts:389',
			'src/services/skill-optimizer/store.ts:340',
			'src/services/skill-optimizer/store.ts:503',
			'src/turbo/epic/state.ts:177',
			'src/turbo/epic/calibration.ts:197',
			'src/commands/archive-sqlite.ts:318',
			'src/memory/jsonl-migration.ts:161',
		],
		note: 'fsync-discipline / lock-scoped fd writers whose temp naming is pinned by their own durability test suites (plan-durability invariant 5, #2034 crash matrix); grammars registered here so their residue stays discoverable',
	},
	{
		id: 'target-suffix-tmp-token',
		era: 'current',
		match: /^(.+)\.tmp\.[0-9a-z-]{6,}$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/turbo/lean/state.ts:246',
			'src/turbo/lean/recovery.ts:175',
			'src/hooks/delegation-gate/worktree-merge-status.ts:110',
		],
	},
	{
		id: 'target-suffix-tmp-dash',
		era: 'current',
		match: /^(.+)\.tmp-\d+-[0-9a-z-]+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/services/skill-evaluator.ts:492 (pre-#2035)',
			'src/services/skill-improver.ts:154 (pre-#2035)',
			'src/services/skill-consolidation.ts:72 (pre-#2035)',
			'src/services/skill-generator.ts:601 (pre-#2035)',
			'src/tools/spec-write.ts:98',
			'src/sdd/effective-spec.ts:1149',
			'src/background/lane-output-store.ts:353',
			'src/background/pending-delegations.ts:1091',
			'src/background/delegation-health.ts:391',
			'src/tools/submit-phase-council-verdicts.ts:458',
			'src/summaries/store.ts:46 (pre-#2035)',
		],
		note: 'background lane/delegation stores keep bounded-retry rename semantics wired into their callers (#2034/#2276 delivery contracts); migration candidates for a follow-up but grammars registered',
	},
	{
		id: 'target-suffix-tmp-dash-num',
		era: 'current',
		match: /^(.+)\.tmp-\d+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: ['src/services/skill-improver-quota.ts:114'],
	},
	{
		id: 'target-dot-pid-uuid-tmp',
		era: 'current',
		match: new RegExp(`^(.+)\\.\\d+\\.${UUID_RE}\\.tmp$`),
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: ['src/hooks/knowledge-receipt-ledger-storage.ts:591'],
		note: 'pre/post-rename file-identity verification (existingFileIdentity checks, knowledge-receipt-ledger-storage.ts:544-591) is writer-specific and load-bearing',
	},
	{
		id: 'dot-numeric-instance-tmp',
		era: 'current',
		match: /^\..+(?:\.\d+){2,4}\.[0-9a-z]+\.tmp$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: false,
		producers: [
			'src/utils/bun-compat.ts:138',
			'src/tools/repo-graph/freshness.ts:171',
		],
		note: 'bunWrite Node-fallback internal temp and the repo-graph fingerprint temp (2-4 numeric token groups); leading-dot temps are standalone, target not parsed',
	},
	{
		id: 'dot-uuid-instance-tmp',
		era: 'current',
		match: new RegExp(`^\\..+\\.${UUID_RE}\\.tmp$`),
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: [
			'src/tools/write-pr-review-artifact.ts:140',
			'src/tools/write-pr-review-artifact.ts:160',
			'src/tools/write-pr-review-trigger-eval.ts:96',
		],
		note: 'bundled-skills writes outside .swarm (project skill roots) and keeps its own contained-directory logic (invariant 4 bundled-skill ownership)',
	},
	{
		id: 'tmp-prefix-named',
		era: 'legacy',
		match: /^\.tmp-.+-\d+-\d+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: false,
		producers: ['src/commands/issue.ts:167 (pre-#2035)'],
		note: 'prefix form embeds the filename; target not reliably parseable (dashes), so eligibility relies on the age/tracked/symlink/lock gates',
	},
	{
		id: 'target-rebuild-close',
		era: 'current',
		match: /^(.+)\.(?:rebuild|close)\.\d+\.[0-9a-z]+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: ['src/plan/manager.ts:1971', 'src/plan/manager.ts:2160'],
		note: 'plan-durability (invariant 5) fd-write paths; grammars registered, writers unchanged in this PR',
	},
	{
		id: 'target-migration-pid',
		era: 'current',
		match: /^(.+)\.migration-\d+$/,
		token: 'instance',
		quarantineEligible: true,
		parsesTarget: true,
		producers: ['src/scope/scope-persistence.ts:633 (pre-#2035)'],
	},
	{
		id: 'dot-tmp-prefix-legacy',
		era: 'legacy',
		match: /^\.tmp\..+$/,
		token: 'constant',
		quarantineEligible: true,
		parsesTarget: false,
		producers: [
			'pre-7.x writers (historical); matched by the pre-#2035 close sweep',
		],
		note: 'legacy prefix grammar: issue #2035 req 7 preserves its handling — stale instances are quarantined (formerly unlinked) under the same eligibility gates',
	},
	{
		id: 'dot-constant-tmp',
		era: 'current',
		match: /^\..+\.tmp$/,
		token: 'constant',
		quarantineEligible: false,
		parsesTarget: false,
		producers: [
			'src/tools/write-drift-evidence.ts:275',
			'src/tools/write-mutation-evidence.ts:169',
			'src/tools/write-hallucination-evidence.ts:121',
			'src/tools/record-implementation-review.ts:87',
			'src/tools/record-recurrence-sweep.ts:125',
			'src/tools/record-issue-reproduction.ts:85',
			'src/tools/record-issue-publication.ts:74',
			'src/tools/write-final-council-evidence.ts:403',
		],
		note: 'constant-name temps: no per-invocation token — reported when stale, never auto-quarantined (may be an in-flight writer of any process)',
	},
	{
		id: 'target-constant-tmp',
		era: 'current',
		match: /^(.+)\.tmp$/,
		token: 'constant',
		quarantineEligible: false,
		parsesTarget: false,
		producers: [
			'src/tools/checkpoint.ts:195',
			'src/full-auto/state.ts:460',
			'src/context-map/persistence.ts:119',
			'src/context-map/capsule-persistence.ts:109',
			'src/test-impact/history-store.ts:225',
			'src/test-impact/history-store.ts:353',
			'src/hooks/promotion-evidence-store.ts:112',
			'src/hooks/skill-usage-log.ts:1165',
			'src/hooks/skill-usage-log.ts:1675',
			'src/hooks/skill-usage-pending.ts:817',
			'src/parallel/file-locks.ts:113',
			'src/plan/ledger.ts:1333',
			'src/plan/ledger.ts:1334',
		],
		note: 'constant-name temps: reported when stale, never auto-quarantined. file-locks meta sidecars live under the scanner-skipped .swarm/locks/ subtree; the ledger reconcile temp embeds instance tokens but its .tmp-suffix shape maps here (conservatively report-only)',
	},
];

/** First registered grammar whose regex matches `basename`, or undefined. */
export function matchTempGrammar(
	basename: string,
): SwarmTempGrammar | undefined {
	return SWARM_TEMP_GRAMMARS.find((g) => g.match.test(basename));
}

/**
 * Parse the target basename a temp name was derived from (capture group 1).
 * Returns null for prefix/leading-dot grammars with no derivable target.
 */
export function parseTargetBasename(basename: string): string | null {
	for (const g of SWARM_TEMP_GRAMMARS) {
		if (!g.parsesTarget) continue;
		const m = g.match.exec(basename);
		if (m?.[1]) return m[1];
	}
	return null;
}

/**
 * Structural classification of every file that constructs temp-file names
 * (ratchet source for tests/unit/utils/atomic-write.test.ts — a new temp
 * constructor must be classified here or the build fails):
 *  - migrated:        writes through the canonical helper (registry lists its
 *                     grammar only for historical residue discovery)
 *  - registered-bespoke: keeps a dedicated writer with a documented invariant
 *                     reason in the grammar `note` (issue #2035 req 2)
 *  - external:        writes outside the `.swarm` containment boundary
 *  - reader-only:     references temp names without constructing them
 */
export const WRITER_CLASSIFICATION: Readonly<
	Record<string, 'migrated' | 'registered-bespoke' | 'external' | 'reader-only'>
> = Object.freeze({
	'src/commands/close.ts': 'migrated',
	'src/commands/handoff.ts': 'migrated',
	'src/commands/simulate.ts': 'migrated',
	'src/commands/coupling.ts': 'migrated',
	'src/commands/issue.ts': 'migrated',
	'src/evidence/task-file.ts': 'migrated',
	'src/evidence/phase-participation.ts': 'migrated',
	'src/memory/reflection-service.ts': 'migrated',
	'src/scope/scope-persistence.ts': 'migrated',
	'src/services/skill-consolidation.ts': 'migrated',
	'src/services/skill-evaluator.ts': 'migrated',
	// mixed .swarm/.opencode-skill destinations — delegates to the any-root
	// variant of the canonical helper (same dual-destination reason as task-file)
	'src/services/skill-generator.ts': 'migrated',
	'src/services/skill-improver.ts': 'migrated',
	'src/summaries/store.ts': 'migrated',
	// delegates every atomic rewrite to the canonical helper (trajectory data
	// file + checkpoint, issue #2041); its `.tmp` mention is the cleanup
	// READER reaping stale atomic-write leftovers, not a constructor
	'src/prm/trajectory-store.ts': 'migrated',
	// registered-bespoke: grammar registered, writer kept (see grammar notes)
	'src/background/delegation-health.ts': 'registered-bespoke',
	'src/background/lane-output-store.ts': 'registered-bespoke',
	'src/background/pending-delegations.ts': 'registered-bespoke',
	'src/commands/archive-sqlite.ts': 'registered-bespoke',
	'src/context-map/capsule-persistence.ts': 'registered-bespoke',
	'src/context-map/persistence.ts': 'registered-bespoke',
	// bespoke atomic single-file rewrite (write tmp + rename) for the bounded
	// context-map telemetry store; PID-scoped `.context-telemetry.jsonl.<pid>.tmp`
	'src/context-map/telemetry.ts': 'registered-bespoke',
	// bespoke atomic single-file rewrites (write tmp + rename) for the bounded
	// core event store and its authority index (issue #2039); PID-scoped
	// `.events.jsonl.<pid>.tmp` / `.events-authority-index.json.<pid>.tmp`
	'src/events/core-events.ts': 'registered-bespoke',
	// bespoke atomic single-file rewrites (write tmp + rename) for the bounded
	// shell-audit security store (issue #2040); PID-scoped
	// `.shell-audit.jsonl.<pid>.tmp`
	'src/hooks/guardrails/shell-audit-store.ts': 'registered-bespoke',
	'src/evidence/documents-retention.ts': 'registered-bespoke',
	'src/evidence/manager.ts': 'registered-bespoke',
	'src/full-auto/state.ts': 'registered-bespoke',
	'src/hooks/delegation-gate/worktree-merge-status.ts': 'registered-bespoke',
	'src/hooks/delegation-gate/worktree-provisioning-owner.ts': 'migrated',
	'src/hooks/issue-trace-state.ts': 'registered-bespoke',
	'src/hooks/knowledge-receipt-ledger-storage.ts': 'registered-bespoke',
	'src/hooks/pr-workflow-gate.ts': 'registered-bespoke',
	// bespoke atomic single-file rewrite (write tmp + rename) for the bounded
	// PR-review re-entry authorization store (issues #2383/#2385; moved to the
	// src/pr-review/ boundary); UUID-scoped `.${basename}.${uuid}.tmp`
	'src/pr-review/authorization.ts': 'registered-bespoke',
	// bespoke atomic single-file rewrite (write tmp + rename) for the PR-review
	// gate-state and salvage reads (issue #2385; the only durable stream is
	// `.swarm/pr-workflow-gates/*.json`, currently UNREGISTERED in the retention
	// data set — F-PRR-013 follow-up); UUID-scoped `.tmp.<pid>.<uuid>`
	'src/pr-review/persistence.ts': 'registered-bespoke',
	'src/hooks/promotion-evidence-store.ts': 'registered-bespoke',
	'src/hooks/review-receipt.ts': 'registered-bespoke',
	'src/hooks/skill-usage-log.ts': 'registered-bespoke',
	'src/hooks/skill-usage-pending.ts': 'registered-bespoke',
	'src/knowledge/identity.ts': 'registered-bespoke',
	'src/memory/jsonl-migration.ts': 'external',
	'src/memory/local-jsonl-provider.ts': 'registered-bespoke',
	'src/plan/ledger.ts': 'registered-bespoke',
	'src/plan/manager.ts': 'registered-bespoke',
	'src/review/evidence.ts': 'registered-bespoke',
	'src/sdd/effective-spec.ts': 'registered-bespoke',
	'src/services/skill-improver-quota.ts': 'registered-bespoke',
	'src/services/skill-optimizer/activation.ts': 'external',
	'src/services/skill-optimizer/store.ts': 'registered-bespoke',
	'src/services/skill-reviser.ts': 'external',
	'src/services/synonym-map.ts': 'registered-bespoke',
	'src/session/snapshot-writer.ts': 'registered-bespoke',
	'src/summaries/manager.ts': 'registered-bespoke',
	'src/test-impact/history-store.ts': 'registered-bespoke',
	'src/turbo/epic/calibration.ts': 'registered-bespoke',
	'src/turbo/epic/state.ts': 'registered-bespoke',
	'src/turbo/lean/evidence.ts': 'registered-bespoke',
	'src/turbo/lean/integration.ts': 'registered-bespoke',
	'src/turbo/lean/recovery.ts': 'registered-bespoke',
	'src/turbo/lean/reviewer.ts': 'registered-bespoke',
	'src/turbo/lean/state.ts': 'registered-bespoke',
	'src/tools/apply-patch.ts': 'external',
	'src/tools/checkpoint.ts': 'registered-bespoke',
	'src/tools/record-implementation-review.ts': 'registered-bespoke',
	'src/tools/record-issue-publication.ts': 'registered-bespoke',
	'src/tools/record-issue-reproduction.ts': 'registered-bespoke',
	'src/tools/record-recurrence-sweep.ts': 'registered-bespoke',
	'src/tools/repo-graph/freshness.ts': 'registered-bespoke',
	'src/tools/repo-graph/storage.ts': 'registered-bespoke',
	'src/tools/sast-baseline.ts': 'registered-bespoke',
	'src/tools/spec-write.ts': 'registered-bespoke',
	'src/tools/submit-phase-council-verdicts.ts': 'registered-bespoke',
	'src/tools/write-drift-evidence.ts': 'registered-bespoke',
	'src/tools/write-final-council-evidence.ts': 'registered-bespoke',
	'src/tools/write-hallucination-evidence.ts': 'registered-bespoke',
	'src/tools/write-mutation-evidence.ts': 'registered-bespoke',
	'src/tools/write-pr-review-artifact.ts': 'registered-bespoke',
	'src/tools/write-pr-review-trigger-eval.ts': 'registered-bespoke',
	// external: writes outside .swarm with its own containment logic
	'src/config/bundled-skills.ts': 'external',
	'src/services/config-doctor.ts': 'external',
	// registered-bespoke (final-critic round): lock-metadata sidecar temps
	// under the scanner-skipped .swarm/locks/ subtree; see target-constant-tmp
	'src/parallel/file-locks.ts': 'registered-bespoke',
	// registered-bespoke (final-critic round): bunWrite's Node-fallback
	// internal temp (dot-numeric-instance-tmp grammar)
	'src/utils/bun-compat.ts': 'registered-bespoke',
	// reader-only: filters/comments/example strings over temp names, never
	// constructs them
	'src/background/plan-sync-worker.ts': 'reader-only',
	'src/config/lane-permissions.ts': 'reader-only',
	'src/environment/profile.ts': 'reader-only',
	'src/worktree/core.ts': 'reader-only',
});

// ─────────────────────────────────────────────────────────────────────────────
// Containment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Max depth considered when reasoning about `.swarm` path segments (advisory
 * constant kept for diagnostics; containment itself is spelling-based).
 */
export const MAX_SWARM_ANCESTOR_DEPTH = 8;

export interface SwarmContainment {
	/** Project root that owns the `.swarm/` directory. */
	projectRoot: string;
	/** Canonical `.swarm/` directory containing the target. */
	swarmRoot: string;
}

/**
 * Reject obviously-invalid target spellings before any filesystem access:
 * glob metacharacters, control chars/NUL, and unresolved environment-variable
 * forms (`$VAR`, `%VAR%`, leading `~`). Quarantine/inventory paths and writer
 * paths share this gate (issue #2035 req 7).
 */
export function assertWellFormedTargetPath(targetPath: string): void {
	if (!path.isAbsolute(targetPath)) {
		throw new Error(`atomic-write target must be absolute: ${targetPath}`);
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching control chars to reject them (doctor.ts precedent)
	if (/[\0-\x1f\x7f]/.test(targetPath)) {
		throw new Error('atomic-write target contains control characters');
	}
	if (
		/[*?]/.test(targetPath) ||
		/(^|[/\\])\{[^}]*\}([/\\]|$)/.test(targetPath)
	) {
		throw new Error(
			`atomic-write target contains glob metacharacters: ${targetPath}`,
		);
	}
	if (/(^|[/\\])~([/\\]|$)/.test(targetPath)) {
		throw new Error(
			'atomic-write target contains unresolved home-dir marker (~)',
		);
	}
	if (
		/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(targetPath) ||
		/%[^/\\%]+%/.test(targetPath)
	) {
		throw new Error(
			'atomic-write target contains unresolved environment-variable form',
		);
	}
}

function lstatNotSymlink(p: string, what: string): void {
	const st = fs.lstatSync(p); // throws ENOENT for missing — callers pre-check
	if (st.isSymbolicLink()) {
		throw new Error(`${what} is a symlink/reparse point: ${p}`);
	}
}

/**
 * Assert `targetPath` lives beneath a `.swarm/` root.
 *
 * The root is determined by SPELLING: the nearest `.swarm` path segment
 * between the filesystem root and the target. Existence-based ancestor
 * walking is deliberately avoided — a stray `.swarm` in an ancestor (e.g. the
 * OS temp dir) would hijack the walk and reject legitimate first-writes whose
 * own `.swarm` parent does not exist yet (invariant 4: ambiguous ancestor
 * `.swarm` state fails closed). If the `.swarm` root exists it must be a real
 * directory (no symlink), and no existing path segment between it and the
 * target may be a symlink.
 *
 * KNOWN LIMITATION vs `validateSwarmPath` (src/hooks/utils.ts:157, PR review
 * PRR-007): this check detects SYMLINKS via lstatSync().isSymbolicLink(),
 * which returns FALSE for Windows directory JUNCTIONS (a distinct reparse
 * class). validateSwarmPath resolves all reparse points via realpathSync. A
 * junctioned `.swarm/` therefore passes this spelling-based gate. Mitigations
 * in scope: junctions require same-user filesystem write access to create
 * (outside the adversarial-local-process threat model invariant 4 excludes),
 * targets are still spelling-bounded to the `.swarm` subtree, and the
 * spell-time `.swarm` position must already exist in the user's path. Full
 * junction parity would require realpath-resolution of every existing
 * ancestor — deliberately out of budget for the write hot path.
 *
 * Project-boundary enforcement (`.git`/`.opencode` markers, invariant 4) is
 * deliberately NOT re-checked here: that belongs to the tool-layer
 * resolvers (`resolveWorkingDirectory`/`assertProjectRoot`), which have
 * already validated the directory before any writer derived a target from
 * it — validateSwarmPath applies the same split.
 */
export function assertSwarmContainedTarget(
	targetPath: string,
): SwarmContainment {
	assertWellFormedTargetPath(targetPath);
	const resolved = path.normalize(path.resolve(targetPath));
	const segments = resolved.split(path.sep);
	let swarmIdx = -1;
	for (let i = segments.length - 2; i >= 1; i--) {
		if (segments[i] === '.swarm') {
			swarmIdx = i;
			break;
		}
	}
	if (swarmIdx === -1) {
		throw new Error(
			`atomic-write target is not under a project .swarm root: ${targetPath}`,
		);
	}
	const swarmRoot = segments.slice(0, swarmIdx + 1).join(path.sep);
	// A pre-existing `.swarm` root must be a real directory. ENOENT is fine —
	// the mkdir in writeAtomicSync creates it (first write into a fresh root).
	try {
		const st = fs.lstatSync(swarmRoot);
		if (!st.isDirectory() || st.isSymbolicLink()) {
			throw new Error(
				`.swarm root is not a real directory (symlink/reparse or non-dir): ${swarmRoot}`,
			);
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
	}
	const rel = path.relative(swarmRoot, resolved);
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`atomic-write target escapes .swarm root: ${targetPath}`);
	}
	// Deny symlinked segments between swarmRoot and the target's nearest
	// existing ancestor (the not-yet-existing tail cannot be a link).
	let probe = swarmRoot;
	for (const seg of rel.split(path.sep)) {
		probe = path.join(probe, seg);
		if (!fs.existsSync(probe)) break;
		lstatNotSymlink(probe, 'path segment under .swarm');
	}
	return { projectRoot: path.dirname(swarmRoot), swarmRoot };
}

// ─────────────────────────────────────────────────────────────────────────────
// Canonical writer
// ─────────────────────────────────────────────────────────────────────────────

/** Hard bound on a single atomic write (bounded-write requirement). */
export const MAX_ATOMIC_WRITE_BYTES = 256 * 1024 * 1024;

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200] as const;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

export interface AtomicWriteOptions {
	/** Skip the pre-rename fsync (tests / truly ephemeral data). */
	readonly skipFsync?: boolean;
	/** File mode for the per-write temporary file before rename. */
	readonly mode?: number;
	/**
	 * Override the bounded-write cap (default MAX_ATOMIC_WRITE_BYTES). Exposed
	 * so the bound itself is testable without allocating 256 MiB.
	 */
	readonly maxBytes?: number;
}

/**
 * Dependency-injection seam for failure-injection tests (repo convention;
 * never mock.module — it leaks across bun:test files). Restore in afterEach.
 *
 * The defaults DELEGATE to the live `fs` namespace on every call (instead of
 * capturing the function at module load) so sibling tests that patch
 * `node:fs` via `mock.module` — while still calling through to the real
 * implementation — observe these calls, matching the recording patterns in
 * tests/unit/commands/atomic-writes.test.ts.
 */
export const _internals = {
	randomSuffix: (): string => randomBytes(16).toString('hex'),
	writeSync: (
		fd: number,
		buffer: Uint8Array,
		offset: number,
		length: number,
	): number => fs.writeSync(fd, buffer, offset, length),
	renameSync: (from: string, to: string): ReturnType<typeof fs.renameSync> =>
		fs.renameSync(from, to),
	unlinkSync: (p: string): ReturnType<typeof fs.unlinkSync> => fs.unlinkSync(p),
	fsyncSync: (fd: number): ReturnType<typeof fs.fsyncSync> => fs.fsyncSync(fd),
};

function toBuffer(content: string | Uint8Array): Uint8Array {
	if (typeof content === 'string') return Buffer.from(content, 'utf-8');
	return content;
}

/** Portable synchronous sleep (pending-delegations.ts/transient-retry precedent).
 * The busy-wait fallback is theoretical on supported runtimes (Atomics.wait is
 * available on all Node/Bun versions this repo ships) and burns CPU only when
 * Atomics is unavailable — bounded by RENAME_RETRY_DELAYS_MS (385ms worst
 * case). Kept for precedent-consistency (PR review PRR-011: documented, not
 * load-bearing). */
function syncSleep(ms: number): void {
	try {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	} catch {
		const start = Date.now();
		while (Date.now() - start < ms) {
			/* bounded busy-wait fallback */
		}
	}
}

function renameWithRetry(tempPath: string, targetPath: string): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
		try {
			_internals.renameSync(tempPath, targetPath);
			return;
		} catch (err) {
			lastError = err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (!code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
			if (attempt < RENAME_RETRY_DELAYS_MS.length) {
				syncSleep(RENAME_RETRY_DELAYS_MS[attempt]);
			}
		}
	}
	throw lastError;
}

/** Shared core: validate, write temp, fsync, rename, cleanup own temp. */
function writeAtomicSync(
	targetPath: string,
	content: string | Uint8Array,
	options?: AtomicWriteOptions & { contained?: boolean },
): void {
	if (options?.contained !== false) {
		assertSwarmContainedTarget(targetPath);
	} else {
		// Any-root callers (linked/hive knowledge stores) still get the
		// well-formedness guards — never globs, env forms, or relative paths.
		assertWellFormedTargetPath(targetPath);
	}
	const resolvedTarget = path.resolve(targetPath);
	const buffer = toBuffer(content);
	const maxBytes = options?.maxBytes ?? MAX_ATOMIC_WRITE_BYTES;
	if (buffer.byteLength > maxBytes) {
		throw new Error(
			`atomic write exceeds ${maxBytes} byte bound: ${buffer.byteLength}`,
		);
	}
	// Canonical grammar: <target>.<hex32>.tmp — unique, non-predictable, and
	// derived from the target so residue scanners can attribute it exactly.
	// The temp shares the target's directory by construction (same-directory
	// rename requirement).
	const tempPath = `${resolvedTarget}.${_internals.randomSuffix()}.tmp`;
	fs.mkdirSync(path.dirname(tempPath), { recursive: true });
	// The own-temp finally-unlink must cover the WRITE phase too: a failed
	// write (ENOSPC/EBADF/…) that propagates before the rename block would
	// otherwise leak this invocation's temp as new residue (issue #2035
	// acceptance: "failed writes clean only their own temp and preserve the
	// previous target").
	try {
		const fd = fs.openSync(tempPath, 'wx', options?.mode);
		try {
			let written = 0;
			while (written < buffer.byteLength) {
				written += _internals.writeSync(
					fd,
					buffer,
					written,
					buffer.byteLength - written,
				);
			}
			if (options?.skipFsync !== true) {
				try {
					_internals.fsyncSync(fd);
				} catch {
					// fsync unsupported on this FS — durability is best-effort
				}
			}
		} finally {
			fs.closeSync(fd);
		}
		renameWithRetry(tempPath, resolvedTarget);
	} finally {
		// Exact finally cleanup of THIS invocation's temp only (no-op after a
		// successful rename — ENOENT is swallowed).
		try {
			_internals.unlinkSync(tempPath);
		} catch {
			/* renamed away or never created */
		}
	}
	// Best-effort parent-dir fsync so the rename itself is durable (macOS/APFS).
	try {
		const dirFd = fs.openSync(path.dirname(resolvedTarget), 'r');
		try {
			fs.fsyncSync(dirFd);
		} finally {
			fs.closeSync(dirFd);
		}
	} catch {
		// directory fsync unsupported — best-effort
	}
	invalidateCachedArtifact(resolvedTarget);
}

/**
 * Canonical atomic write under the project `.swarm/` root (issue #2035 req 1):
 * contained target, unique non-predictable same-directory temp, bounded write,
 * fsync+close where supported, platform-safe replace (bounded rename retry on
 * Windows transient locks — never unlink-then-rename, which would break
 * atomicity), and exact finally cleanup of this invocation's temp only.
 *
 * The payload is bounded (≤ MAX_ATOMIC_WRITE_BYTES), so the synchronous
 * temp-write core is the same latency class as the previous per-caller
 * write-temp implementations; the async signature preserves caller shapes.
 */
export async function atomicWriteSwarmFile(
	targetPath: string,
	content: string | Uint8Array,
	options?: AtomicWriteOptions,
): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	writeAtomicSync(targetPath, content, options);
}

/** Synchronous variant of {@link atomicWriteSwarmFile} (same core). */
export function atomicWriteSwarmFileSync(
	targetPath: string,
	content: string | Uint8Array,
	options?: AtomicWriteOptions,
): void {
	writeAtomicSync(targetPath, content, options);
}

/**
 * Canonical atomic write WITHOUT the `.swarm` containment requirement.
 *
 * Documented invariant reason this variant exists (issue #2035 req 2): the
 * legacy shared writer `atomicWriteFile` (src/evidence/task-file.ts) serves
 * DUAL destinations — `.swarm/evidence/**` files AND the linked/hive
 * knowledge stores whose platform-data/link directories live OUTSIDE any
 * `.swarm` root (src/hooks/knowledge-store.ts, knowledge-link.ts,
 * memory-link.ts, family migrations). Those callers migrate to this variant
 * so they still gain the canonical grammar, fsync, bounded retry, exact
 * own-temp cleanup, and cache invalidation — everything except root
 * containment, which their destinations make inapplicable. New `.swarm`
 * callers MUST use {@link atomicWriteSwarmFile}.
 */
export async function atomicWriteFileAnyRoot(
	targetPath: string,
	content: string | Uint8Array,
	options?: AtomicWriteOptions,
): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	writeAtomicSync(targetPath, content, { ...options, contained: false });
}
