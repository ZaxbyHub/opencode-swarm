/**
 * Issue #3011 Phase 4.2 guardrail — defect class:
 * "process-local identity state (module-level mutable numeric counters or
 * keyed maps) whose values are stamped into durable records".
 *
 * In-class history: #2576 (tool-summarizer S1), #2720 (context-map
 * decisionCounter), #3011 (reactive mirror reactiveOversightSequence — the
 * counter was deleted and allocation routed through the durable allocator
 * `nextFullAutoOversightSequence`).
 *
 * This test is a RECURRING ratchet (runs in CI), not a one-time census:
 *
 *  1. Counter classification ratchet — every src/ file declaring a
 *     module-level mutable numeric counter (`let x[: number]? = <digits>;`)
 *     must carry an explicit classification entry below with a reason.
 *     A NEW counter cannot appear silently: it fails this test until the
 *     author classifies it (and a classification claiming durable-identity
 *     use must name the durable allocator or derive-from-store helper that
 *     actually owns the identity — both in-class remedy shapes are
 *     compliant: shared durable counter (#3011) and derive-from-store
 *     max+1 (#2720 allocateDecisionId / #2576 allocateSummaryId)).
 *  2. Guardrail-bites demo — the classifier run over a fixture reproducing
 *     the ORIGINAL #3011 defect shape (module counter feeding a persisted
 *     oversight_sequence stamp with no classification) must FAIL it. This is
 *     the RED-half proof; the src/ scan is the GREEN half.
 *  3. Grammar-coupling pin — the evidence writer's filename builder and the
 *     allocator's catch-up scanner must BOTH come from the single leaf
 *     module `src/full-auto/evidence-names.ts`, so the writer and the
 *     scanner cannot drift apart (#3011).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE,
	fullAutoOversightEvidenceFileName,
} from '../../../src/full-auto/evidence-names';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const srcRoot = path.join(repoRoot, 'src');

/** Module-level mutable numeric counters, e.g. `let foo = 0;` / `let bar: number = 1;`. */
const MODULE_COUNTER_RE =
	/^let [A-Za-z_$][A-Za-z0-9_$]*(:\s*number)?\s*=\s*\d+;\s*$/;

/**
 * Classification map: why each counter-carrying src/ file is NOT an instance
 * of the defect class. Audited 2026-10-01 (issue #3011 Phase 4.2 census).
 * Categories:
 *   metrics   — telemetry/rate/cache statistics; never stamped as durable identity
 *   timestamp — wall-clock ms bookkeeping (last-sweep/last-warn), not identity
 *   cache     — cache/generation epoch for invalidation, not durable identity
 *   ordering  — in-memory ordering only; durable identity (if any) comes from
 *               UUIDs, Date-prefixed ids, or durable-store-derived generations
 *   shadow    — test-only in-memory shadow synced FROM the durable allocator
 */
const CLASSIFIED: Record<string, string> = {
	'src/host/v2/setup.ts':
		'ordering: v2SetupOwnerCounter sequences per-setup owner tokens for the v2 adapter state registries (rebuild source, quiet, model-apply surface); the token is process-scoped only — never persisted, never crosses a restart',
	'src/host/v2/session-client.ts':
		'ordering: placeholderCounter sequences placeholder minting; the v2shim-<n>-<random> ids ARE persisted by v2 callers (dispatch_lanes writes them as background-delegations correlationId/subagentSessionId), but durable uniqueness across restarts comes from the random suffix, never the counter — the host-minted session id is tracked only in the in-session placeholder map',
	'src/telemetry.ts': 'metrics: _emitCount (emit budget telemetry)',
	'src/index.ts':
		'metrics: instanceExitCleanupCounter / serverInitInvocations (init telemetry)',
	'src/state.ts': 'timestamp: _lastIdleSweepAtMs (idle sweep cadence)',
	'src/background/candidate-contract.ts':
		'metrics: candidateArtifactCacheHits/Misses (cache statistics)',
	'src/background/pr-event-delivery.ts':
		'ordering: nextRegistrationSequence orders in-memory registrations; identity is randomUUID ownerToken',
	'src/background/pr-feedback-loop.ts':
		'metrics: activeCancellationRequests (in-flight gauge)',
	'src/background/pr-feedback-loop-runtime.ts':
		'ordering: nextRegistrationSequence orders in-memory registrations; identity is randomUUID ownerToken',
	'src/context-map/telemetry.ts':
		'metrics: _recordCount / _lastWarnAt (telemetry cadence)',
	'src/events/core-events.ts':
		'metrics: _appendCount / _lastWarnAt (append budget telemetry)',
	'src/hooks/knowledge-injector.ts':
		'cache: knowledgeGeneration (injection freshness comparison, not identity)',
	'src/hooks/pr-workflow-auto-wake.ts':
		'ordering: nextMarkerID is one input to the timestamp-prefixed collision-resistant message id grammar',
	'src/hooks/skill-usage-pending.ts':
		'timestamp: _pressureCheckedAt (pressure check cadence)',
	'src/hooks/trajectory-step-state.ts':
		'cache: stepCounterGeneration (invalidation epoch)',
	'src/hooks/skill-usage-log.ts':
		'metrics: _appendCount / _suppressedOptionalAppends / _appendsSinceCompaction (log budget telemetry)',
	'src/lang/dispatch.ts':
		'ordering: insertCounter / manifestRootInsertCounter (in-memory prompt assembly order)',
	'src/observability/observe.ts':
		'metrics: _writerSequence (in-process envelope write order telemetry; restart duplicates are not durable-record identity)',
	'src/hooks/guardrails/shell-audit-store.ts':
		'metrics: _appendCount / _lastWarnAt (append budget telemetry)',
	'src/prm/trajectory-store.ts':
		'metrics/timestamp: skippedLockAppends / lastAppendSkipEventAtMs / lastCleanupScheduledAtMs (store telemetry cadence)',
	'src/sast/semgrep.ts': 'cache: semgrepAvailabilityGeneration (probe epoch)',
	'src/services/injection-budget.ts':
		'ordering: turnGenerationCounter (in-memory turn epoch)',
	'src/services/model-preflight.ts':
		'cache: catalogCacheEpoch (model catalog epoch)',
	'src/session/hydration-ownership.ts':
		'cache: hydrationAuthorityEpoch (ownership epoch)',
	'src/session/snapshot-coordination-init.ts':
		'ordering: nextAttemptId orders in-process readiness entries; durable authority derives from the persisted generation (+1) and the hydration scope token (#2667/#2668)',
	'src/utils/bun-compat.ts':
		'ordering: tempCounter (transient scratch temp-dir names, not durable records)',
	'src/utils/git-executable.ts': 'cache: cacheGeneration (resolution epoch)',
	'src/utils/gh-executable.ts': 'cache: cacheGeneration (resolution epoch)',
	'src/utils/glab-executable.ts': 'cache: cacheGeneration (resolution epoch)',
};

interface CounterFile {
	relPath: string;
	counters: string[];
}

function scanForModuleCounters(root: string): CounterFile[] {
	const hits: CounterFile[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) {
				continue;
			}
			const text = fs.readFileSync(full, 'utf-8');
			// Module-level only: the declaration sits at column 0. Indented
			// `let x = 0;` is function-scoped scratch state, not module state,
			// and is outside this defect class.
			const counters = text
				.split('\n')
				.filter((line) => MODULE_COUNTER_RE.test(line.trimEnd()))
				.map(
					(line) =>
						line
							.trimEnd()
							.replace(/^let\s+/, '')
							.split(/[:=]/)[0]
							?.trim() ?? line.trimEnd(),
				);
			if (counters.length > 0) {
				hits.push({
					relPath: path.relative(root, full).replace(/\\/g, '/'),
					counters,
				});
			}
		}
	};
	walk(root);
	return hits.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

describe('issue #3011 guardrail — process-local identity counters over durable stores', () => {
	test('every src/ module-level numeric counter is explicitly classified', () => {
		const hits = scanForModuleCounters(srcRoot);
		const unclassified = hits.filter((h) => !CLASSIFIED[`src/${h.relPath}`]);
		expect(
			unclassified.map((h) => `src/${h.relPath}: ${h.counters.join(', ')}`),
		).toEqual([]);
		// The census itself is live: every classification entry must still
		// name a file that carries a counter (no dead entries accrete).
		const livePaths = new Set(hits.map((h) => `src/${h.relPath}`));
		const dead = Object.keys(CLASSIFIED).filter((p) => !livePaths.has(p));
		expect(dead).toEqual([]);
	});

	test('guardrail bites: the original #3011 defect shape is unclassified and fails the scan', () => {
		// Fixture reproducing the pre-fix source shape: a module-level counter
		// stamped into a persisted oversight event with no classification.
		const fixtureDir = canonicalMkdtemp('p3011-guardrail-');
		try {
			fs.mkdirSync(path.join(fixtureDir, 'hooks'), { recursive: true });
			fs.writeFileSync(
				path.join(fixtureDir, 'hooks', 'full-auto-intercept.ts'),
				[
					'let reactiveOversightSequence = 0;',
					'',
					'async function mirrorReactiveVerdictToV2() {',
					'\treactiveOversightSequence += 1;',
					'\tconst event = {',
					"\t\ttype: 'full_auto_oversight',",
					'\t\toversight_sequence: reactiveOversightSequence,',
					'\t};',
					'\tawait v2WriteOversightEvidence(directory, phase, event);',
					'}',
					'',
				].join('\n'),
				'utf-8',
			);
			const hits = scanForModuleCounters(fixtureDir);
			expect(hits).toHaveLength(1);
			expect(hits[0]?.counters).toContain('reactiveOversightSequence');
			// The ratchet leg: the file has no classification entry, so this
			// scan reports it — exactly how #3011 would be caught on arrival.
			const unclassified = hits.filter((h) => !CLASSIFIED[`src/${h.relPath}`]);
			expect(unclassified).toHaveLength(1);
		} finally {
			fs.rmSync(fixtureDir, { recursive: true, force: true });
		}
	});

	test('grammar coupling: writer and scanner share the evidence-names leaf', () => {
		expect(fullAutoOversightEvidenceFileName(7)).toBe('full-auto-7.json');
		expect(FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE.test('full-auto-7.json')).toBe(
			true,
		);
		expect(
			FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE.test('full-auto-7.json.bak'),
		).toBe(false);
		const oversight = fs.readFileSync(
			path.join(srcRoot, 'full-auto', 'oversight.ts'),
			'utf-8',
		);
		const state = fs.readFileSync(
			path.join(srcRoot, 'full-auto', 'state.ts'),
			'utf-8',
		);
		expect(oversight).toContain(
			"import { fullAutoOversightEvidenceFileName } from './evidence-names'",
		);
		expect(state).toContain(
			"import { FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE } from './evidence-names'",
		);
		// And the writer must actually BUILD its filename through the leaf —
		// not through a re-derived template literal that could drift.
		expect(oversight).toContain('fullAutoOversightEvidenceFileName(');
		expect(state).toContain('FULL_AUTO_OVERSIGHT_EVIDENCE_FILE_RE');
		expect(state).not.toContain('full-auto-${');
	});
});
