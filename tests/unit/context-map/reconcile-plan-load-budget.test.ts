/**
 * r16 audit (P2, 7.2): the context-map release reconciliation must load the
 * plan ONCE per pass, not once per pending completed task.
 *
 * `reconcileContextMapTaskReleases` verified each candidate task through
 * `resolveContextMapTaskReleaseStatus`, whose LAST step reloads the plan
 * (`loadPlanJsonOnly`). The plan is process-cached (mtime-keyed artifact
 * cache), but every cached load still costs a stat plus a structuredClone of
 * the ENTIRE plan — so a pass over N pending completed tasks performed N+1
 * plan loads, O(N²) cloned bytes overall. Measured pre-repair (r16):
 * 100/500/1000 tasks → 101/501/1001 plan loads and 136/750/2895 ms for the
 * first pass; the reconciliation runs at maintenance points including the
 * /swarm status path and post-init background maintenance, so this cost sat
 * on a hot path with no budget of its own.
 *
 * The repair splits the durable-evidence proof
 * (`resolveTaskReleaseEvidenceProof`) from the plan-status check; the
 * reconciliation holds the once-loaded plan and iterates only completed
 * tasks, so the per-task work is one bounded evidence read. Post-repair
 * measurement: exactly 1 plan load per pass at every N, 111/363/1243 ms.
 *
 * This test pins the deterministic part of that budget — the number of
 * artifact-cache plan loads (parsed reads + parsed cache hits) per
 * reconciliation pass — plus the correctness (all provable tasks promoted,
 * permanently broken entries stay pending without breaking the pass).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import { loadContextMap } from '../../../src/context-map/persistence';
import { reconcileContextMapTaskReleases } from '../../../src/context-map/post-agent-update';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { resetStartupLedgerCheck } from '../../../src/plan/manager';
import { resetSwarmState } from '../../../src/state';
import {
	getSwarmArtifactCacheStats,
	resetSwarmArtifactCache,
} from '../../../src/utils/swarm-artifact-cache';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { freezeClock } from '../../helpers/test-clock';

const HEALTHY = 150;
const BROKEN = 5;

function writeProject(directory: string): void {
	const tasks = Array.from(
		{ length: HEALTHY + BROKEN },
		(_, i) =>
			({
				id: `1.${i + 1}`,
				phase: 1,
				status: 'completed',
				size: 'small',
				description: `task ${i + 1}`,
				depends: [],
				files_touched: [`src/f${i}.ts`],
			}) as Plan['phases'][0]['tasks'][0],
	);
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'r16 plan-load budget plan',
		swarm: 'r16-load-budget',
		current_phase: 1,
		phases: [{ id: 1, name: 'P', status: 'in_progress', tasks }],
	} as Plan;
	fs.mkdirSync(join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(join(directory, '.opencode'), { recursive: true });
	fs.writeFileSync(
		join(directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	fs.writeFileSync(
		join(directory, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ context_map: { enabled: true } }),
	);
	const now = new Date().toISOString();
	const gate = (agent: string) => ({
		sessionId: `ses-${agent}`,
		timestamp: now,
		agent,
	});
	// The first HEALTHY tasks carry full valid QA evidence; the last BROKEN
	// tasks deliberately have NO evidence file — permanently broken entries
	// that every pass re-checks and must leave pending without failing.
	for (let i = 1; i <= HEALTHY; i++) {
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
					lastTransitionId: `budget:${i}`,
					updatedAt: now,
				},
			}),
		);
	}
}

function planLoadsSince(
	before: ReturnType<typeof getSwarmArtifactCacheStats>,
): number {
	const after = getSwarmArtifactCacheStats();
	return (
		after.parsedReadCount -
		before.parsedReadCount +
		(after.parsedCacheHitCount - before.parsedCacheHitCount)
	);
}

describe('context-map reconciliation — one plan load per pass (r16 7.2)', () => {
	let directory: string;
	let cleanup: () => void;
	let restoreClock: () => void;

	beforeEach(() => {
		restoreClock = freezeClock({
			// The numeric clock and the ISO stamp are the SAME instant
			// (2025-07-15T12:00:00Z): under a freeze they must not disagree.
			fixedNow: 1_752_580_800_000,
			isoNow: '2025-07-15T12:00:00.000Z',
		});
		resetSwarmState();
		resetStartupLedgerCheck();
		({ dir: directory, cleanup } = createSafeTestDir('ctxmap-loadbudget-'));
		writeProject(directory);
	});

	afterEach(() => {
		restoreClock();
		resetSwarmState();
		resetStartupLedgerCheck();
		closeAllProjectDbs();
		resetSwarmArtifactCache();
		cleanup();
	});

	test('a first pass over N pending completed tasks performs ONE plan load and promotes every provable task', async () => {
		resetSwarmArtifactCache();
		const before = getSwarmArtifactCacheStats();
		await reconcileContextMapTaskReleases(directory);
		const loads = planLoadsSince(before);

		// THE budget: exactly the single reconcile-top plan load (the
		// per-task evidence proof must not touch the plan artifact cache).
		// Pre-repair this was 1 + HEALTHY (each resolveContextMapTaskRelease
		// reloaded the plan: a stat + structuredClone of the whole plan).
		expect(loads).toBeLessThanOrEqual(2);

		const history = loadContextMap(directory)?.task_history ?? {};
		for (let i = 1; i <= HEALTHY; i++) {
			expect(history[`1.${i}`]?.final_status).toBe('approved');
		}
		// Permanently broken entries stay pending (fail-closed) and do not
		// break the pass.
		for (let i = HEALTHY + 1; i <= HEALTHY + BROKEN; i++) {
			expect(history[`1.${i}`]?.final_status ?? 'pending').toBe('pending');
		}
	});

	test('a steady-state pass (everything terminal) is O(1) in plan loads', async () => {
		await reconcileContextMapTaskReleases(directory);

		resetSwarmArtifactCache();
		const before = getSwarmArtifactCacheStats();
		await reconcileContextMapTaskReleases(directory);
		const loads = planLoadsSince(before);

		// Terminal entries are skipped before any per-task I/O; only the
		// single reconcile-top plan load remains.
		expect(loads).toBeLessThanOrEqual(2);
	});
});
