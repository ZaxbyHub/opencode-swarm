/**
 * Issue #2668 coordination supersession boundaries.
 *
 * These tests hold the real post-resolution initializer at each asynchronous
 * boundary and then begin a newer hydration generation.  The assertions are
 * on durable SQLite/projection state and readiness, not on copied helpers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	loadPlan,
	PlanRecoverySupersededError,
	_internals as planManagerInternals,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import {
	beginHydrationScope,
	hydrationProjectKey,
} from '../../../src/session/hydration-ownership';
import {
	_snapshotCoordinationInternals,
	ensureSnapshotCoordinationReady,
	getSnapshotCoordinationStatus,
	startSnapshotCoordinationInitialization,
} from '../../../src/session/snapshot-coordination-init';
import {
	readSnapshotRows,
	writeSnapshotRows,
} from '../../../src/session/snapshot-store';
import {
	SNAPSHOT_PROJECTION_FILE,
	type SnapshotData,
	writeSnapshotProjection,
} from '../../../src/session/snapshot-writer';
import {
	buildRehydrationCache,
	ensureAgentSession,
	resetSwarmState,
} from '../../../src/state';
import { invalidateCachedArtifact } from '../../../src/utils/swarm-artifact-cache';
import { writeApprovedPlan } from '../../../tests/helpers/approved-plan';
import { safeRmRecursive } from '../../helpers/safe-test-dir';
import { withFrozenClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalLoadPlan = _snapshotCoordinationInternals.loadPlan;
const originalReadSnapshotFileStrict =
	_snapshotCoordinationInternals.readSnapshotFileStrict;
const originalReadPlanJsonUtf8 = planManagerInternals.readPlanJsonUtf8;
const temporaryDirectories: string[] = [];

function makeSnapshot(marker: string): SnapshotData {
	return {
		version: 3,
		writtenAt: withFrozenClock(() => Date.now()),
		toolAggregates: { [marker]: { count: 1 } },
		activeAgent: {},
		delegationChains: {},
		agentSessions: {},
	} as unknown as SnapshotData;
}

function makeProject(label: string): string {
	const directory = canonicalMkdtemp(`swarm-2668-coordination-${label}-`);
	mkdirSync(path.join(directory, '.git'));
	temporaryDirectories.push(directory);
	return directory;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error('timed out waiting for coordination boundary');
}

beforeEach(() => {
	_snapshotCoordinationInternals.entries.clear();
	_snapshotCoordinationInternals.loadPlan = originalLoadPlan;
	_snapshotCoordinationInternals.readSnapshotFileStrict =
		originalReadSnapshotFileStrict;
	planManagerInternals.readPlanJsonUtf8 = originalReadPlanJsonUtf8;
	resetStartupLedgerCheck();
	resetSwarmState();
});

afterEach(() => {
	_snapshotCoordinationInternals.entries.clear();
	_snapshotCoordinationInternals.loadPlan = originalLoadPlan;
	_snapshotCoordinationInternals.readSnapshotFileStrict =
		originalReadSnapshotFileStrict;
	planManagerInternals.readPlanJsonUtf8 = originalReadPlanJsonUtf8;
	resetStartupLedgerCheck();
	resetSwarmState();
	closeAllProjectDbs();
	for (const directory of temporaryDirectories.splice(0)) {
		safeRmRecursive(directory);
	}
});

describe('coordination supersession regression (#2668)', () => {
	test('does not import a compatibility snapshot after strict read is superseded', async () => {
		const directory = makeProject('compat-import');
		await writeSnapshotProjection(directory, makeSnapshot('stale-compat'));

		let releaseRead!: () => void;
		let strictReadStarted = false;
		const readBarrier = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		_snapshotCoordinationInternals.readSnapshotFileStrict = async (
			root,
			relativePath,
		) => {
			strictReadStarted = true;
			await readBarrier;
			return originalReadSnapshotFileStrict(root, relativePath);
		};

		const initialization = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => strictReadStarted);
		beginHydrationScope(directory);
		releaseRead();
		await initialization;

		expect(readSnapshotRows(directory)).toBeNull();
		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'superseded',
			settled: true,
		});
	});

	test('publishes superseded readiness instead of late projection state', async () => {
		const directory = makeProject('readiness');
		writeSnapshotRows(directory, makeSnapshot('authoritative'));
		await writeSnapshotProjection(directory, makeSnapshot('before-late-write'));
		const projectionPath = path.join(
			directory,
			'.swarm',
			SNAPSHOT_PROJECTION_FILE,
		);
		const projectionBefore = readFileSync(projectionPath, 'utf8');

		let releasePlan!: () => void;
		let loadPlanStarted = false;
		const planBarrier = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		_snapshotCoordinationInternals.loadPlan = async (root, cache, options) => {
			loadPlanStarted = true;
			await planBarrier;
			return originalLoadPlan(root, cache, options);
		};

		const initialization = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => loadPlanStarted);
		beginHydrationScope(directory);
		releasePlan();
		await expect(initialization).rejects.toBeInstanceOf(
			PlanRecoverySupersededError,
		);

		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'superseded',
			settled: true,
		});
		expect(readFileSync(projectionPath, 'utf8')).toBe(projectionBefore);
	});

	test('does not let delayed loadPlan recovery mutate stale projections', async () => {
		const directory = makeProject('load-plan-side-effects');
		await writeApprovedPlan(directory, [
			{
				id: '1.1',
				files: ['src/recovery-boundary.ts'],
				status: 'completed',
			},
		]);
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const markdownPath = path.join(directory, '.swarm', 'plan.md');
		const invalidPlanJson = '{not valid json';
		writeFileSync(planPath, invalidPlanJson);
		const markdownBefore = readFileSync(markdownPath, 'utf8');

		let releaseRead!: () => void;
		let readStarted = false;
		const readBarrier = new Promise<void>((resolve) => {
			releaseRead = resolve;
		});
		planManagerInternals.readPlanJsonUtf8 = async (root) => {
			readStarted = true;
			await readBarrier;
			return originalReadPlanJsonUtf8(root);
		};

		const initialization = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => readStarted);
		beginHydrationScope(directory);
		releaseRead();
		await expect(initialization).rejects.toBeInstanceOf(
			PlanRecoverySupersededError,
		);

		expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
			state: 'superseded',
			settled: true,
		});
		expect(readFileSync(planPath, 'utf8')).toBe(invalidPlanJson);
		expect(readFileSync(markdownPath, 'utf8')).toBe(markdownBefore);
	});

	test('retries a superseded attempt and runs current-generation ledger recovery', async () => {
		const directory = makeProject('retry-authority');
		const executionProfile = {
			parallelization_enabled: true,
			max_concurrent_tasks: 2,
			council_parallel: false,
			locked: false,
			auto_proceed: true,
			commit_after_each_completed_task: false,
			planning_profile: 'balanced' as const,
		};
		const expected = await writeApprovedPlan(
			directory,
			[
				{
					id: '1.1',
					files: ['src/current-generation.ts'],
					status: 'completed',
				},
			],
			{ executionProfile },
		);
		const planPath = path.join(directory, '.swarm', 'plan.json');
		writeFileSync(planPath, '{not valid json');
		writeSnapshotRows(directory, makeSnapshot('retry-authority'));

		let releaseFirstPlan!: () => void;
		let loadPlanCalls = 0;
		const firstPlanBarrier = new Promise<void>((resolve) => {
			releaseFirstPlan = resolve;
		});
		_snapshotCoordinationInternals.loadPlan = async (root, cache, options) => {
			loadPlanCalls += 1;
			if (loadPlanCalls === 1) await firstPlanBarrier;
			return originalLoadPlan(root, cache, options);
		};

		const staleAttempt = startSnapshotCoordinationInitialization(directory);
		await waitFor(() => loadPlanCalls === 1);
		beginHydrationScope(directory);
		releaseFirstPlan();
		await expect(staleAttempt).rejects.toBeInstanceOf(
			PlanRecoverySupersededError,
		);
		expect(getSnapshotCoordinationStatus(directory).state).toBe('superseded');

		await startSnapshotCoordinationInitialization(directory);
		expect(loadPlanCalls).toBe(2);
		expect(getSnapshotCoordinationStatus(directory).state).toBe('succeeded');
		expect(JSON.parse(readFileSync(planPath, 'utf8'))).toMatchObject({
			swarm: expected.swarm,
			title: expected.title,
			execution_profile: expected.execution_profile,
		});
	});

	test('releases a claimed startup recovery when superseded before replay (F2)', async () => {
		const directory = makeProject('startup-claim');
		const expected = await writeApprovedPlan(directory, [
			{
				id: '1.1',
				files: ['src/startup-claim.ts'],
				status: 'completed',
			},
		]);
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const staleProjection = JSON.parse(readFileSync(planPath, 'utf8')) as {
			phases: Array<{ tasks: Array<{ status: string }> }>;
		};
		// Before the cleanup fix, this valid-but-stale projection caused the
		// first loadPlan call to claim the one-shot startup replay. If authority
		// superseded it afterward, the claim leaked and the next invocation
		// skipped the required ledger-authoritative recovery.
		staleProjection.phases[0]!.tasks[0]!.status = 'pending';
		writeFileSync(planPath, JSON.stringify(staleProjection));
		invalidateCachedArtifact(planPath);
		await planManagerInternals.regeneratePlanMarkdown(
			directory,
			staleProjection as Plan,
		);

		let preCommitChecks = 0;
		await expect(
			loadPlan(directory, undefined, {
				preCommitCheck: () => {
					preCommitChecks += 1;
					if (preCommitChecks === 3) {
						throw new PlanRecoverySupersededError(
							'startup replay superseded by a newer hydration generation',
						);
					}
				},
			}),
		).rejects.toBeInstanceOf(PlanRecoverySupersededError);
		expect(preCommitChecks).toBe(3);

		const recovered = await loadPlan(directory);
		expect(recovered?.phases[0]?.tasks[0]?.status).toBe('completed');
		expect(
			(JSON.parse(readFileSync(planPath, 'utf8')) as typeof expected).phases[0]
				?.tasks[0]?.status,
		).toBe('completed');
	});
});

describe('PR #2777 coordination feedback regressions', () => {
	describe('IA-001 — plan recovery supersession', () => {
		test('preserves typed supersession before stale cache and projection publication', async () => {
			const directory = makeProject('IA-001-plan-recovery');
			const snapshot = makeSnapshot('authoritative');
			writeSnapshotRows(directory, snapshot);
			await writeSnapshotProjection(
				directory,
				makeSnapshot('pre-resolution-projection'),
			);
			const projectionPath = path.join(
				directory,
				'.swarm',
				SNAPSHOT_PROJECTION_FILE,
			);
			const projectionBefore = readFileSync(projectionPath, 'utf8');
			await writeApprovedPlan(directory, [
				{
					id: '1.1',
					files: ['src/stale-cache-probe.ts'],
					status: 'completed',
				},
			]);
			const cacheBuild = await buildRehydrationCache(directory);
			expect(cacheBuild.committed).toBe(true);

			let releasePlan!: () => void;
			let loadPlanStarted = false;
			const planBarrier = new Promise<void>((resolve) => {
				releasePlan = resolve;
			});
			_snapshotCoordinationInternals.loadPlan = async () => {
				loadPlanStarted = true;
				await planBarrier;
				throw new PlanRecoverySupersededError(
					'newer plan recovery authority won',
				);
			};

			const initialization = startSnapshotCoordinationInitialization(directory);
			await waitFor(() => loadPlanStarted);
			const session = ensureAgentSession('ia-001-cache-probe', 'coder');
			session.owningProjectKey = hydrationProjectKey(directory);
			expect(session.taskWorkflowStates.get('1.1')).toBeUndefined();

			// Before this fix, the generic catch consumed this typed supersession,
			// then applied the pre-resolution completed task and rewrote the projection.
			releasePlan();
			await expect(initialization).rejects.toBeInstanceOf(
				PlanRecoverySupersededError,
			);
			expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
				state: 'superseded',
				settled: true,
			});
			expect(session.taskWorkflowStates.get('1.1')).toBeUndefined();
			expect(readFileSync(projectionPath, 'utf8')).toBe(projectionBefore);
		});
	});

	describe('F-001 — readiness re-drive after supersession', () => {
		test('redrives after real typed supersession from the plan pre-commit fence', async () => {
			const directory = makeProject('F-001-readiness-redrive');
			await writeApprovedPlan(directory, [
				{
					id: '1.1',
					files: ['src/readiness-redrive-probe.ts'],
					status: 'completed',
				},
			]);
			let loadPlanCalls = 0;
			_snapshotCoordinationInternals.loadPlan = async (
				root,
				cache,
				options,
			) => {
				loadPlanCalls += 1;
				if (loadPlanCalls === 1) beginHydrationScope(root);
				return originalLoadPlan(root, cache, options);
			};

			await expect(
				startSnapshotCoordinationInitialization(directory),
			).rejects.toBeInstanceOf(PlanRecoverySupersededError);
			expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
				state: 'superseded',
				settled: true,
			});
			expect(loadPlanCalls).toBe(1);

			// The first loadPlan call used the real coordinator preCommitCheck, which
			// observed the newer hydration generation. Readiness then starts one fresh
			// attempt under the current generation and completes normally.
			await expect(
				ensureSnapshotCoordinationReady(directory),
			).resolves.toBeUndefined();
			expect(loadPlanCalls).toBe(2);
			expect(getSnapshotCoordinationStatus(directory)).toMatchObject({
				state: 'succeeded',
				settled: true,
			});
		});
	});
});
