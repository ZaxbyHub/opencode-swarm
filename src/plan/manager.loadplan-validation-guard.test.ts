/**
 * Tests for the migration-aware identity guard in loadPlan()'s validation-failure
 * catch path (lines ~299-323 of manager.ts).
 *
 * When plan.json fails schema validation, the old code unconditionally called
 * replayFromLedger(). This allowed a post-migration ledger (old identity) to
 * overwrite a schema-invalid but correctly migrated plan.json.
 *
 * The fix: extract swarm+title from the raw JSON (even if schema validation
 * fails), compare against the first ledger event's plan_id, and only replay
 * when identities match.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeRmRecursive } from '../../tests/helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir';
import type { Plan } from '../config/plan-schema';
import { initLedger, takeSnapshotEvent } from './ledger';
import { loadPlan, savePlan } from './manager';

let testDir: string;

function makeTestPlan(overrides?: Partial<Plan>): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Test Plan',
		swarm: 'test-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task 1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
		...overrides,
	};
}

beforeEach(() => {
	testDir = canonicalMkdtemp('loadplan-validation-guard-');
});

afterEach(() => {
	safeRmRecursive(testDir);
});

describe('loadPlan() validation-failure catch path: identity guard', () => {
	test('invalid plan.json with identity mismatch → falls through to plan.md, does NOT replay old ledger', async () => {
		// Setup: old ledger with old swarm identity
		const oldPlan = makeTestPlan({ swarm: 'old-swarm' });
		await savePlan(testDir, oldPlan);
		// Ledger now has plan_id = 'old-swarm-Test_Plan'

		// Write invalid plan.json: new swarm identity but missing required 'phases' field
		const swarmDir = path.join(testDir, '.swarm');
		const invalidPlan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'new-swarm',
			current_phase: 1,
			// MISSING: phases — schema validation will fail
		};
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(invalidPlan),
			'utf8',
		);

		// Write plan.md with new-swarm content as the recovery fallback
		const planMd = `# Test Plan
Swarm: new-swarm
Phase: 1

## Phase 1 [pending]
- [ ] 1.1: Task 1 [small]
`;
		fs.writeFileSync(path.join(swarmDir, 'plan.md'), planMd, 'utf8');

		const result = await loadPlan(testDir);

		// Must return the new-swarm plan from plan.md, NOT old-swarm from ledger
		expect(result).not.toBeNull();
		expect(result!.swarm).toBe('new-swarm');

		// plan.json should be rewritten from the plan.md migration, not the old ledger
		const onDisk = JSON.parse(
			fs.readFileSync(path.join(swarmDir, 'plan.json'), 'utf8'),
		);
		expect(onDisk.swarm).toBe('new-swarm');
	});

	test('invalid plan.json with MATCHING identity + ledger snapshot → ledger replay is allowed', async () => {
		// Setup: valid plan saved with same identity, snapshot taken (stores full
		// plan state in ledger), then plan.json corrupted. With a snapshot in the
		// ledger, replayFromLedger can recover the full plan without depending on
		// the corrupted plan.json as a base.
		const plan = makeTestPlan({ swarm: 'my-swarm', title: 'My Plan' });
		await savePlan(testDir, plan);
		// Ledger has plan_id = 'my-swarm-My_Plan'

		// Take a snapshot so the ledger contains the full plan state
		await takeSnapshotEvent(testDir, plan);

		const swarmDir = path.join(testDir, '.swarm');

		// Corrupt plan.json: same swarm+title but missing phases (schema invalid)
		const invalidPlan = {
			schema_version: '1.0.0',
			title: 'My Plan',
			swarm: 'my-swarm',
			current_phase: 1,
			// MISSING: phases — schema validation fails
		};
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			JSON.stringify(invalidPlan),
			'utf8',
		);

		// Remove plan.md so plan.md fallback cannot mask a ledger replay failure
		try {
			fs.unlinkSync(path.join(swarmDir, 'plan.md'));
		} catch {
			/* ok */
		}

		// loadPlan: JSON parse succeeds, schema fails → catch path
		// Identity matches → allows ledger replay → snapshot restores full plan
		const result = await loadPlan(testDir);

		expect(result).not.toBeNull();
		expect(result!.swarm).toBe('my-swarm');
		expect(result!.title).toBe('My Plan');
		expect(result!.phases.length).toBeGreaterThan(0);
	});

	test('plan.json is completely malformed JSON → cannot extract identity → conservative skip, falls through to plan.md', async () => {
		// Setup: create old ledger
		const swarmDir = path.join(testDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		await initLedger(testDir, 'some-swarm-Some_Plan');

		// Write plan.json that is not valid JSON at all
		fs.writeFileSync(
			path.join(swarmDir, 'plan.json'),
			'{ this is not valid JSON <<<',
			'utf8',
		);

		// Write plan.md as the fallback
		const planMd = `# Recovery Plan
Swarm: fallback-swarm
Phase: 1

## Phase 1 [pending]
- [ ] 1.1: Task 1 [small]
`;
		fs.writeFileSync(path.join(swarmDir, 'plan.md'), planMd, 'utf8');

		// loadPlan cannot extract identity from malformed JSON → skips ledger replay
		// → falls through to plan.md migration
		const result = await loadPlan(testDir);

		expect(result).not.toBeNull();
		// Should come from plan.md, not from the ledger
		expect(result!.swarm).toBe('fallback-swarm');
	});
});
