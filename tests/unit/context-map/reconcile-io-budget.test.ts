/**
 * r17 audit (P2, §6): regression bounds on the REAL plan.json I/O of a
 * context-map release-reconciliation pass — beyond the artifact-cache loads
 * the r16 budget test counts.
 *
 * The r16 optimization removed the per-task `loadPlanJsonOnly` reload, but
 * `resolveTaskReleaseEvidenceProof` still raw-read plan.json TWICE per
 * candidate (`resolveCurrentPlanIdentitySync` + `readCurrentTaskDeclaredFiles`)
 * — invisible to the artifact-cache stats. Measured pre-repair with strace
 * (physical openat on .swarm/plan.json, driver script + harness kept in the
 * r17 report): 403/2003/4003 opens for N=100/500/1000 first passes,
 * 414/1680/4239 ms. Post-repair: 103/503/1003 opens (exactly the
 * promotion-fence read per PROMOTED task), 366/1145/2724 ms; steady-state
 * pass unchanged (~1 load, ms-scale).
 *
 * The repair passes a once-loaded READ-ONLY proof snapshot (plan identity
 * hash + per-task declared files) into the evidence proof; the promotion
 * fence re-verifies the CURRENT task status AND plan identity at the
 * mandatory write point, so a plan that changed identity mid-pass fails
 * closed (stale proofs are never written).
 *
 * Counting method in THIS test: the raw plan readers are routed through the
 * `_planProofReaders` seam (lazily bound to the real gate-evidence
 * functions), so the test can count invocations — each is one physical
 * plan.json read — without mocking `node:fs` (mock.module on node:fs wedges
 * Bun 1.4.4's module machinery: a single loadPluginConfig read looped
 * unboundedly; see the r17 session report). Physical-read parity is proven
 * separately by the strace harness numbers above.
 */
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import {
	_planProofReaders,
	reconcileContextMapTaskReleases,
} from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import {
	getSwarmArtifactCacheStats,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

function writeProject(directory: string, taskCount: number): void {
	const tasks = Array.from({ length: taskCount }, (_, i) => ({
		id: `1.${i + 1}`,
		phase: 1,
		status: 'completed',
		size: 'small',
		description: `task ${i + 1}`,
		depends: [],
		files_touched: [`src/f${i}.ts`],
	}));
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'r17 io budget plan',
			swarm: 'r17-io-budget',
			current_phase: 1,
			phases: [{ id: 1, name: 'P', status: 'in_progress', tasks }],
		}),
	);
	const now = new Date().toISOString();
	const gate = (agent: string) => ({
		sessionId: `ses-${agent}`,
		timestamp: now,
		agent,
	});
	for (let i = 1; i <= taskCount; i++) {
		fs.writeFileSync(
			join(directory, '.swarm', 'evidence', `1.${i}.json`),
			JSON.stringify({
				taskId: `1.${i}`,
				required_gates: ['pre_check', 'reviewer', 'test_engineer'],
				gates: {
					pre_check: gate('pre_check'),
					reviewer: gate('reviewer'),
					test_engineer: gate('test_engineer'),
				},
				workflow: {
					schema: 'exact-task-v1',
					generation: 0,
					state: 'complete',
					retryCount: 0,
					retryHistory: [],
					retryEpoch: 0,
					lastOutcome: 'task_completed',
					lastTransitionId: `io:${i}`,
					updatedAt: now,
				},
			}),
		);
	}
}

describe('context-map reconciliation — real plan.json I/O per pass (r17 §6)', () => {
	let directory: string;
	let cleanup: () => void;
	/** Invocation counters for the seamed raw plan readers. */
	let identityReads: number;
	let declaredFilesReads: number;
	let originalReaders: typeof _planProofReaders;
	// The REAL reader implementations (bound once in beforeAll) the counting
	// wrappers delegate to — the seam's lazy binding sees non-null wrappers
	// and skips its own binding, so the test must own the real refs itself.
	let realIdentity: typeof _planProofReaders.resolveCurrentPlanIdentitySync;
	let realDeclared: typeof _planProofReaders.readCurrentTaskDeclaredFiles;
	let restoreClock: () => void;

	beforeAll(async () => {
		const gate = await import('../../../src/gate-evidence.js');
		realIdentity = gate.resolveCurrentPlanIdentitySync;
		realDeclared = gate.readCurrentTaskDeclaredFiles;
	});

	beforeEach(() => {
		restoreClock = freezeClock({
			// The numeric clock and the ISO stamp are the SAME instant
			// (2025-07-15T12:00:00Z): under a freeze they must not disagree.
			fixedNow: 1_752_580_800_000,
			isoNow: '2025-07-15T12:00:00.000Z',
		});
		resetSwarmState();
		resetStartupLedgerCheck();
		resetSwarmArtifactCache();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-io-budget-'));
		fs.mkdirSync(join(directory, '.swarm', 'evidence'), { recursive: true });
		fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
		fs.writeFileSync(
			join(directory, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({ context_map: { enabled: true } }),
		);
		originalReaders = { ..._planProofReaders };
		identityReads = 0;
		declaredFilesReads = 0;
		// Counting wrappers that DELEGATE to the real implementations, so
		// behavior is unchanged — only observability is added.
		_planProofReaders.resolveCurrentPlanIdentitySync = (dir) => {
			identityReads++;
			return realIdentity(dir);
		};
		_planProofReaders.readCurrentTaskDeclaredFiles = (dir, taskId) => {
			declaredFilesReads++;
			return realDeclared(dir, taskId);
		};
	});

	afterEach(() => {
		restoreClock();
		_planProofReaders.resolveCurrentPlanIdentitySync =
			originalReaders.resolveCurrentPlanIdentitySync;
		_planProofReaders.readCurrentTaskDeclaredFiles =
			originalReaders.readCurrentTaskDeclaredFiles;
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		resetSwarmArtifactCache();
		cleanup();
	});

	test('a first pass over N pending completed tasks performs ZERO per-task raw plan reads', async () => {
		for (const n of [100, 500, 1000]) {
			writeProject(directory, n);
			// Seed a readable map with pending entries so every task reaches
			// the evidence proof (the pass does not stop at map creation).
			let map = createEmptyContextMap();
			for (let i = 1; i <= n; i++) {
				map = appendTaskHistory(map, {
					task_id: `1.${i}`,
					goal: '',
					files_touched: [],
					implementation_summary: 'pending',
					final_status: 'pending',
				});
			}
			saveContextMap(map, directory);

			resetSwarmArtifactCache();
			identityReads = 0;
			declaredFilesReads = 0;
			const cacheBefore = getSwarmArtifactCacheStats();

			const startedAt = performance.now();
			await reconcileContextMapTaskReleases(directory);
			const durationMs = performance.now() - startedAt;

			const cacheAfter = getSwarmArtifactCacheStats();
			const cachePlanLoads =
				cacheAfter.parsedReadCount -
				cacheBefore.parsedReadCount +
				(cacheAfter.parsedCacheHitCount - cacheBefore.parsedCacheHitCount);

			// Correctness: every provable task promoted.
			const history = loadContextMap(directory)?.task_history ?? {};
			let promoted = 0;
			for (let i = 1; i <= n; i++) {
				if (history[`1.${i}`]?.final_status === 'approved') promoted++;
			}
			expect(promoted).toBe(n);

			// THE regression bound: the snapshot-supplied proof performs NO
			// per-task raw plan reads. Pre-repair this was 2 reads per
			// candidate (identity + declared files): 200/1000/2000 invocations
			// for N=100/500/1000 (strace: 403/2003/4003 physical opens).
			expect(identityReads).toBe(0);
			expect(declaredFilesReads).toBe(0);

			// The r16 artifact-cache budget still holds: one cached plan load
			// per pass (the promotion fence reads raw, not through the cache).
			expect(cachePlanLoads).toBeLessThanOrEqual(2);

			console.log(
				`[r17-io] N=${n} first-pass: rawIdentityReads=${identityReads} rawDeclaredFilesReads=${declaredFilesReads} cachePlanLoads=${cachePlanLoads} durationMs=${durationMs} promoted=${promoted}`,
			);

			// Reset the fixtures for the next N.
			cleanup();
			({ dir: directory, cleanup } = createSafeTestDir('ctxmap-io-budget-'));
			fs.mkdirSync(join(directory, '.swarm', 'evidence'), { recursive: true });
			fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
			fs.writeFileSync(
				join(directory, '.opencode', 'opencode-swarm.json'),
				JSON.stringify({ context_map: { enabled: true } }),
			);
		}
	});

	test('a snapshot-free proof (no snapshot argument) still uses the raw readers', async () => {
		// Control: the public proof API without a snapshot keeps its
		// fresh-read semantics (used by resolveContextMapTaskReleaseStatus on
		// the per-completion paths).
		const { resolveTaskReleaseEvidenceProof } = await import(
			'../../../src/context-map/post-agent-update.js'
		);
		writeProject(directory, 1);
		const proven = await resolveTaskReleaseEvidenceProof(directory, '1.1');
		expect(proven).toBe(true);
		expect(identityReads).toBe(1);
		expect(declaredFilesReads).toBe(1);
	});

	test('a steady-state pass (everything already released) does no per-task I/O', async () => {
		writeProject(directory, 100);
		// First pass promotes everything.
		await reconcileContextMapTaskReleases(directory);

		resetSwarmArtifactCache();
		identityReads = 0;
		declaredFilesReads = 0;
		const cacheBefore = getSwarmArtifactCacheStats();

		const startedAt = performance.now();
		await reconcileContextMapTaskReleases(directory);
		const durationMs = performance.now() - startedAt;

		const cacheAfter = getSwarmArtifactCacheStats();
		const cachePlanLoads =
			cacheAfter.parsedReadCount -
			cacheBefore.parsedReadCount +
			(cacheAfter.parsedCacheHitCount - cacheBefore.parsedCacheHitCount);

		// Terminal entries are skipped before any per-task I/O.
		expect(identityReads).toBe(0);
		expect(declaredFilesReads).toBe(0);
		expect(cachePlanLoads).toBeLessThanOrEqual(2);

		console.log(
			`[r17-io] steady-state: rawIdentityReads=${identityReads} rawDeclaredFilesReads=${declaredFilesReads} cachePlanLoads=${cachePlanLoads} durationMs=${durationMs}`,
		);
	});

	test('a plan identity change mid-pass fails closed at the write point', async () => {
		// The snapshot must never bypass the write-point authority check: a
		// plan whose IDENTITY changed after the pass loaded it must not be
		// promoted from the stale proofs (the fence skips and the next pass
		// re-derives).
		writeProject(directory, 1);
		const planPath = join(directory, '.swarm', 'plan.json');

		const { promoteContextMapTaskReleaseLocked } = await import(
			'../../../src/context-map/post-agent-update.js'
		);
		// The current plan identity (as the pass would derive it)...
		const current = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
		const { derivePlanIdentityHash } = await import(
			'../../../src/plan/utils.js'
		);
		const passHash = derivePlanIdentityHash({
			swarm: current.swarm,
			title: current.title,
		});

		// ...but the plan on disk has a DIFFERENT identity at write time
		// (campaign restart between the pass's load and the promotion).
		current.title = 'restarted campaign';
		fs.writeFileSync(planPath, JSON.stringify(current));

		await promoteContextMapTaskReleaseLocked(directory, '1.1', 5_000, passHash);
		expect(
			loadContextMap(directory)?.task_history['1.1']?.final_status ?? 'absent',
		).toBe('absent');
	});
});
