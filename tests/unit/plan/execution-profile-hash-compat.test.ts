import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	computePlanHash,
	computePlanStructureHash,
	initLedger,
	readLedgerEvents,
} from '../../../src/plan/ledger';
import {
	isPlanMdInSync,
	loadPlan,
	regeneratePlanMarkdown,
	resetStartupLedgerCheck,
} from '../../../src/plan/manager';
import { derivePlanId } from '../../../src/plan/utils';
import { withSafeTestDir } from '../../helpers/safe-test-dir';

function createLegacyPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Legacy Execution Profile',
		swarm: 'hash-compat',
		current_phase: 1,
		execution_profile: {
			parallelization_enabled: true,
			max_concurrent_tasks: 3,
			council_parallel: false,
			locked: true,
			auto_proceed: true,
		},
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Preserve pre-upgrade hashes',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	} as Plan;
}

function withCommitPolicy(plan: Plan, enabled: boolean): Plan {
	return {
		...plan,
		execution_profile: {
			...plan.execution_profile!,
			commit_after_each_completed_task: enabled,
		},
	};
}

describe('execution profile hash compatibility — regression: default-false field (critic F1)', () => {
	test('missing and explicit false are equivalent, while true changes both ledger hashes', () => {
		// Previous code serialized the schema-injected false value, so merely
		// loading a pre-upgrade plan changed both durable identity hashes.
		const legacy = createLegacyPlan();
		const explicitFalse = withCommitPolicy(legacy, false);
		const explicitTrue = withCommitPolicy(legacy, true);

		expect(computePlanHash(explicitFalse)).toBe(computePlanHash(legacy));
		expect(computePlanHash(explicitTrue)).not.toBe(computePlanHash(legacy));
		expect(computePlanStructureHash(explicitFalse)).toBe(
			computePlanStructureHash(legacy),
		);
		expect(computePlanStructureHash(explicitTrue)).not.toBe(
			computePlanStructureHash(legacy),
		);
	});

	test('missing and explicit false share a plan.md hash, while true invalidates it', async () => {
		// Previous computePlanContentHash serialized false, regenerating plan.md
		// solely because PlanSchema materialized a new default.
		await withSafeTestDir(async (dir) => {
			const legacy = createLegacyPlan();
			await regeneratePlanMarkdown(dir, legacy);

			expect(await isPlanMdInSync(dir, withCommitPolicy(legacy, false))).toBe(
				true,
			);
			expect(await isPlanMdInSync(dir, withCommitPolicy(legacy, true))).toBe(
				false,
			);
		}, 'execution-profile-content-hash-');
	});

	test('pre-upgrade ledger stays stable across repeated fresh loads', async () => {
		// Previous computePlanHash saw PlanSchema's injected false as a mutation,
		// triggering a plan_rebuilt event and rewriting the projection on first load.
		await withSafeTestDir(async (dir) => {
			const legacy = createLegacyPlan();
			const swarmDir = join(dir, '.swarm');
			const planPath = join(swarmDir, 'plan.json');
			await mkdir(swarmDir, { recursive: true });
			writeFileSync(planPath, JSON.stringify(legacy, null, 2), 'utf8');
			await initLedger(
				dir,
				derivePlanId(legacy),
				computePlanHash(legacy),
				legacy,
			);

			try {
				for (let freshLoad = 0; freshLoad < 3; freshLoad += 1) {
					resetStartupLedgerCheck();
					const loaded = await loadPlan(dir);
					expect(
						loaded?.execution_profile?.commit_after_each_completed_task,
					).toBe(false);
					const events = await readLedgerEvents(dir);
					expect(events).toHaveLength(1);
					expect(
						events.some((event) => event.event_type === 'plan_rebuilt'),
					).toBe(false);
				}

				const persisted = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
				expect(
					Object.hasOwn(
						persisted.execution_profile!,
						'commit_after_each_completed_task',
					),
				).toBe(false);
			} finally {
				resetStartupLedgerCheck();
			}
		}, 'execution-profile-ledger-compat-');
	});
});
