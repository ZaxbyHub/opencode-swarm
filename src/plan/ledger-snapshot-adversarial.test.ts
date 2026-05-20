/**
 * Adversarial tests for in-ledger snapshot events.
 * Tests attack vectors against the snapshot event system.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
	appendLedgerEvent,
	computePlanHash,
	replayFromLedger,
	takeSnapshotEvent,
} from './ledger';
import { savePlan } from './manager';

function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-snap-adv-'));
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	return dir;
}

function cleanupTempDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe('in-ledger snapshot adversarial tests', () => {
	const initialPlan = {
		schema_version: '1.0.0' as const,
		title: 'Adversarial Test Plan',
		swarm: 'mega',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending' as const,
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending' as const,
						size: 'small' as const,
						description: 'Task 1.1',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};

	afterEach(() => {
		// No global state to clean
	});

	test('takeSnapshotEvent appends valid snapshot event with payload_hash', async () => {
		const testDir = createTempDir();
		try {
			await savePlan(testDir, initialPlan);

			const snapshotEvent = await takeSnapshotEvent(testDir, initialPlan);
			expect(snapshotEvent.event_type).toBe('snapshot');
			expect(snapshotEvent.payload).toBeDefined();
			expect(snapshotEvent.payload!.payload_hash).toHaveLength(64);
			expect(
				(snapshotEvent.payload as { plan: { title: string } }).plan.title,
			).toBe('Adversarial Test Plan');
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('replayFromLedger uses snapshot event as base when plan.json missing', async () => {
		const testDir = createTempDir();
		try {
			await savePlan(testDir, initialPlan);

			// Take snapshot
			await takeSnapshotEvent(testDir, initialPlan);

			// Delete plan.json
			fs.unlinkSync(path.join(testDir, '.swarm', 'plan.json'));

			// Replay should succeed using snapshot event as base
			const rebuilt = await replayFromLedger(testDir);
			expect(rebuilt).not.toBeNull();
			expect(rebuilt!.title).toBe('Adversarial Test Plan');
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('replayFromLedger returns null when neither plan.json, embedded plan, nor snapshot event exists', async () => {
		const testDir = createTempDir();
		try {
			// Write plan.json first
			const swarmDir = path.join(testDir, '.swarm');
			const planJsonPath = path.join(swarmDir, 'plan.json');
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			// Write a legacy-format ledger manually (no embedded plan payload)
			// to simulate the scenario where neither plan.json, snapshot event, nor
			// embedded plan is available (pre-#444 legacy ledger format).
			const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
			const planHash = computePlanHash(initialPlan);
			const legacyEvent = {
				seq: 1,
				timestamp: new Date().toISOString(),
				plan_id: `${initialPlan.swarm}-${initialPlan.title}`.replace(
					/[^a-zA-Z0-9-_]/g,
					'_',
				),
				event_type: 'plan_created',
				source: 'initLedger',
				plan_hash_before: '',
				plan_hash_after: planHash,
				schema_version: '1.0.0',
				// No 'payload' field — no embedded plan
			};
			fs.writeFileSync(ledgerPath, JSON.stringify(legacyEvent) + '\n', 'utf8');

			// Delete plan.json
			fs.unlinkSync(planJsonPath);

			const rebuilt = await replayFromLedger(testDir);
			expect(rebuilt).toBeNull();
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('snapshot event with corrupted payload is handled gracefully', async () => {
		const testDir = createTempDir();
		try {
			await savePlan(testDir, initialPlan);

			// Append a corrupted snapshot event manually
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			const corruptedEvent = JSON.stringify({
				seq: 2,
				timestamp: new Date().toISOString(),
				plan_id: 'adv-test',
				event_type: 'snapshot',
				source: 'adversarial',
				plan_hash_before: 'abc',
				plan_hash_after: 'def',
				schema_version: '1.0.0',
				payload: { plan: null, payload_hash: 'corrupted' },
			});
			fs.appendFileSync(ledgerPath, `${corruptedEvent}\n`);

			// Replay should handle gracefully — either skip or return null
			const rebuilt = await replayFromLedger(testDir);
			// Either null (can't use corrupted snapshot) or a valid plan (fell back to plan.json)
			if (rebuilt !== null) {
				expect(rebuilt.title).toBe('Adversarial Test Plan');
			}
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('snapshot event with oversized payload does not crash', async () => {
		const testDir = createTempDir();
		try {
			const massivePlan = {
				...initialPlan,
				phases: [
					{
						...initialPlan.phases[0],
						tasks: Array.from({ length: 1000 }, (_, i) => ({
							id: `1.${i + 1}`,
							phase: 1,
							status: 'pending' as const,
							size: 'small' as const,
							description: `Task 1.${i + 1}`,
							depends: [],
							files_touched: [],
						})),
					},
				],
			};
			await savePlan(testDir, massivePlan);

			// Snapshot with 1000 tasks should not crash
			const snapshotEvent = await takeSnapshotEvent(testDir, massivePlan);
			expect(snapshotEvent.event_type).toBe('snapshot');

			// Replay should handle large payload
			const rebuilt = await replayFromLedger(testDir);
			expect(rebuilt).not.toBeNull();
			expect(rebuilt!.phases[0].tasks).toHaveLength(1000);
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('multiple snapshot events — replay uses latest', async () => {
		const testDir = createTempDir();
		try {
			await savePlan(testDir, initialPlan);

			// First snapshot
			await takeSnapshotEvent(testDir, initialPlan);

			// Modify plan and take second snapshot
			const modifiedPlan = {
				...initialPlan,
				title: 'Modified Plan',
			};
			await savePlan(testDir, modifiedPlan);
			await takeSnapshotEvent(testDir, modifiedPlan);

			// Delete plan.json
			fs.unlinkSync(path.join(testDir, '.swarm', 'plan.json'));

			// Replay should use latest snapshot (Modified Plan)
			const rebuilt = await replayFromLedger(testDir);
			expect(rebuilt).not.toBeNull();
			expect(rebuilt!.title).toBe('Modified Plan');
		} finally {
			cleanupTempDir(testDir);
		}
	});

	test('snapshot event with plan_reset before it — replay uses snapshot', async () => {
		const testDir = createTempDir();
		try {
			await savePlan(testDir, initialPlan);

			// Append plan_reset event
			await appendLedgerEvent(testDir, {
				event_type: 'plan_reset',
				source: 'adversarial',
				plan_id: 'adv-test',
			});

			// Take snapshot after reset
			await takeSnapshotEvent(testDir, initialPlan);

			// Delete plan.json
			fs.unlinkSync(path.join(testDir, '.swarm', 'plan.json'));

			// Replay should use snapshot event (after plan_reset)
			const rebuilt = await replayFromLedger(testDir);
			expect(rebuilt).not.toBeNull();
			expect(rebuilt!.title).toBe('Adversarial Test Plan');
		} finally {
			cleanupTempDir(testDir);
		}
	});
});
