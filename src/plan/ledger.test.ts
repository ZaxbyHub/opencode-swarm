import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import {
	appendLedgerEvent,
	computeCurrentPlanHash,
	computePlanHash,
	getLatestLedgerSeq,
	initLedger,
	type LedgerEvent,
	LedgerStaleWriterError,
	ledgerExists,
	readLedgerEvents,
	replayFromLedger,
	type SnapshotEventPayload,
	takeSnapshotEvent,
} from '../../src/plan/ledger';

// Test workspace directory
let testDir: string;

describe('ledger', () => {
	beforeEach(() => {
		// Create a temporary test directory
		testDir = fs.mkdtempSync(path.join(__dirname, 'ledger-test-'));
		// Create .swarm/ subdirectory for ledger tests
		fs.mkdirSync(path.join(testDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		// Clean up test directory
		try {
			fs.rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('computePlanHash', () => {
		test('is deterministic - same plan produces same hash', () => {
			const plan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};

			const hash1 = computePlanHash(plan);
			const hash2 = computePlanHash(plan);

			expect(hash1).toBe(hash2);
			expect(hash1).toHaveLength(64); // SHA-256 hex is 64 chars
		});

		test('different plans produce different hashes', () => {
			const plan1: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [],
					},
				],
			};

			const plan2: Plan = {
				...plan1,
				title: 'Different Plan',
			};

			const hash1 = computePlanHash(plan1);
			const hash2 = computePlanHash(plan2);

			expect(hash1).not.toBe(hash2);
		});
	});

	describe('ledgerExists', () => {
		test('returns false when ledger does not exist', async () => {
			expect(await ledgerExists(testDir)).toBe(false);
		});

		test('returns true when ledger exists', async () => {
			await initLedger(testDir, 'test-plan-id');
			expect(await ledgerExists(testDir)).toBe(true);
		});
	});

	describe('getLatestLedgerSeq', () => {
		test('returns 0 for empty ledger', async () => {
			expect(await getLatestLedgerSeq(testDir)).toBe(0);
		});

		test('returns correct seq after adding events', async () => {
			await initLedger(testDir, 'test-plan');

			expect(await getLatestLedgerSeq(testDir)).toBe(1);

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'test',
			});

			expect(await getLatestLedgerSeq(testDir)).toBe(2);
		});
	});

	describe('readLedgerEvents', () => {
		test('returns empty array for empty ledger', async () => {
			const events = await readLedgerEvents(testDir);
			expect(events).toEqual([]);
		});

		test('returns events sorted by seq', async () => {
			await initLedger(testDir, 'test-plan');

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			const events = await readLedgerEvents(testDir);

			expect(events).toHaveLength(3); // init + 2 appended
			expect(events[0].event_type).toBe('plan_created');
			expect(events[1].event_type).toBe('task_added');
			expect(events[2].event_type).toBe('task_status_changed');

			// Verify seq ordering
			expect(events[0].seq).toBe(1);
			expect(events[1].seq).toBe(2);
			expect(events[2].seq).toBe(3);
		});
	});

	describe('initLedger', () => {
		test('creates plan_created event', async () => {
			await initLedger(testDir, 'test-plan-id');

			const events = await readLedgerEvents(testDir);

			expect(events).toHaveLength(1);
			expect(events[0].event_type).toBe('plan_created');
			expect(events[0].plan_id).toBe('test-plan-id');
			expect(events[0].seq).toBe(1);
			expect(events[0].source).toBe('initLedger');
			expect(events[0].schema_version).toBe('1.0.0');
		});

		test('creates ledger file', async () => {
			await initLedger(testDir, 'test-plan');

			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			expect(fs.existsSync(ledgerPath)).toBe(true);
		});

		test('plan_created event has empty plan_hash_before', async () => {
			// Create plan.json before initLedger so it can compute the hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			const events = await readLedgerEvents(testDir);

			expect(events[0].plan_hash_before).toBe('');
			expect(events[0].plan_hash_after).toHaveLength(64);
		});
	});

	describe('appendLedgerEvent', () => {
		test('adds event with correct seq', async () => {
			await initLedger(testDir, 'test-plan');

			const event = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'updateTaskStatus',
			});

			expect(event.seq).toBe(2);
			expect(event.timestamp).toBeTruthy();
		});

		test('adds event with correct plan_hash_before', async () => {
			await initLedger(testDir, 'test-plan');

			// At this point, plan.json should exist and have a hash
			const eventsBefore = await readLedgerEvents(testDir);
			const expectedHashBefore = eventsBefore[0].plan_hash_after;

			const event = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'updateTaskStatus',
			});

			expect(event.plan_hash_before).toBe(expectedHashBefore);
		});

		test('event contains all required fields', async () => {
			// Create plan.json before initLedger so subsequent events have a hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			const event = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.2',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'updateTaskStatus',
			});

			expect(event.seq).toBe(2);
			expect(event.timestamp).toBeDefined();
			expect(event.plan_id).toBe('test-plan');
			expect(event.event_type).toBe('task_status_changed');
			expect(event.task_id).toBe('1.2');
			expect(event.from_status).toBe('pending');
			expect(event.to_status).toBe('in_progress');
			expect(event.source).toBe('updateTaskStatus');
			expect(event.plan_hash_before).toHaveLength(64);
			expect(event.plan_hash_after).toHaveLength(64);
			expect(event.schema_version).toBe('1.0.0');
		});

		test('multiple events have incrementing seq', async () => {
			await initLedger(testDir, 'test-plan');

			const event1 = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'test',
			});

			const event2 = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.2',
				source: 'test',
			});

			const event3 = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			expect(event1.seq).toBe(2);
			expect(event2.seq).toBe(3);
			expect(event3.seq).toBe(4);
		});
	});

	describe('optimistic concurrency control', () => {
		test('appendLedgerEvent throws LedgerStaleWriterError when expectedSeq does not match', async () => {
			// Create plan.json before initLedger so we have a valid hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Current seq is 1, try to append with expectedSeq=0 (stale)
			await expect(
				appendLedgerEvent(
					testDir,
					{
						plan_id: 'test-plan',
						event_type: 'task_added',
						task_id: '1.1',
						source: 'test',
					},
					{ expectedSeq: 0 },
				),
			).rejects.toThrow(LedgerStaleWriterError);
		});

		test('appendLedgerEvent throws LedgerStaleWriterError when expectedHash does not match', async () => {
			// Create plan.json before initLedger so we have a valid hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Modify plan.json externally to change the hash
			const modifiedPlan = {
				...minimalPlan,
				title: 'Modified Plan',
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(modifiedPlan), 'utf8');

			// Get the original hash before modification
			const _currentHash = computeCurrentPlanHash(testDir);

			// Try to append with the old hash (which no longer matches)
			const oldHash = 'oldfakehash1234567890123456789012345678901234567890123';
			await expect(
				appendLedgerEvent(
					testDir,
					{
						plan_id: 'test-plan',
						event_type: 'task_added',
						task_id: '1.1',
						source: 'test',
					},
					{ expectedHash: oldHash },
				),
			).rejects.toThrow(LedgerStaleWriterError);
		});

		test('appendLedgerEvent succeeds when expectedSeq and expectedHash both match', async () => {
			// Create plan.json before initLedger so we have a valid hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Get current seq and hash
			const currentSeq = await getLatestLedgerSeq(testDir);
			const currentHash = computeCurrentPlanHash(testDir);

			// Append with matching expected values - should succeed
			const event = await appendLedgerEvent(
				testDir,
				{
					plan_id: 'test-plan',
					event_type: 'task_added',
					task_id: '1.1',
					source: 'test',
				},
				{ expectedSeq: currentSeq, expectedHash: currentHash },
			);

			expect(event.seq).toBe(currentSeq + 1);
			expect(event.plan_id).toBe('test-plan');
		});

		test('appendLedgerEvent allows stale seq when only hash is provided', async () => {
			// Create plan.json before initLedger so we have a valid hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Get current hash (seq check should be skipped since only hash is provided)
			const currentHash = computeCurrentPlanHash(testDir);

			// Append with matching hash but wrong seq - should succeed because only hash is checked
			const event = await appendLedgerEvent(
				testDir,
				{
					plan_id: 'test-plan',
					event_type: 'task_added',
					task_id: '1.1',
					source: 'test',
				},
				{ expectedHash: currentHash },
			);

			expect(event.seq).toBe(2);
		});

		test('appendLedgerEvent allows stale hash when only seq is provided', async () => {
			// Create plan.json before initLedger so we have a valid hash
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const minimalPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [{ id: 1, name: 'Phase 1', status: 'pending', tasks: [] }],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(minimalPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Get current seq (hash check should be skipped since only seq is provided)
			const currentSeq = await getLatestLedgerSeq(testDir);

			// Append with matching seq but wrong hash - should succeed because only seq is checked
			const event = await appendLedgerEvent(
				testDir,
				{
					plan_id: 'test-plan',
					event_type: 'task_added',
					task_id: '1.1',
					source: 'test',
				},
				{ expectedSeq: currentSeq },
			);

			expect(event.seq).toBe(2);
		});
	});

	describe('append-only verification', () => {
		test('events are never modified in place', async () => {
			await initLedger(testDir, 'test-plan');

			const event = await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'test',
			});

			// Read the ledger file directly
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			const content = fs.readFileSync(ledgerPath, 'utf8');
			const lines = content
				.trim()
				.split('\n')
				.filter((l) => l.trim() !== '');

			// There should be 2 lines (init + append)
			expect(lines).toHaveLength(2);

			// Parse the first event and verify it hasn't changed
			const parsedEvent = JSON.parse(lines[0]) as LedgerEvent;
			expect(parsedEvent.seq).toBe(1);
			expect(parsedEvent.event_type).toBe('plan_created');

			// Parse the second event and verify it hasn't changed
			const parsedEvent2 = JSON.parse(lines[1]) as LedgerEvent;
			expect(parsedEvent2.seq).toBe(2);
			expect(parsedEvent2.task_id).toBe('1.1');

			// Verify the returned event matches what was written
			expect(event.seq).toBe(2);
			expect(event.task_id).toBe('1.1');
		});

		test('new events are appended to existing events', async () => {
			await initLedger(testDir, 'test-plan');

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.1',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_added',
				task_id: '1.2',
				source: 'test',
			});

			const events = await readLedgerEvents(testDir);

			expect(events).toHaveLength(3);
			expect(events[1].task_id).toBe('1.1');
			expect(events[2].task_id).toBe('1.2');
		});
	});

	describe('all event types', () => {
		test('can create events of each valid type', async () => {
			await initLedger(testDir, 'test-plan');

			const eventTypes = [
				'task_added',
				'task_updated',
				'task_status_changed',
				'task_reordered',
				'phase_completed',
				'plan_rebuilt',
				'plan_exported',
				'plan_reset',
			] as const;

			for (let i = 0; i < eventTypes.length; i++) {
				const eventType = eventTypes[i];
				const event = await appendLedgerEvent(testDir, {
					plan_id: 'test-plan',
					event_type: eventType,
					source: 'test',
					...(eventType === 'task_status_changed' && {
						task_id: '1.1',
						from_status: 'pending',
						to_status: 'in_progress',
					}),
					...(eventType === 'task_added' && { task_id: '1.1' }),
					...(eventType === 'task_updated' && { task_id: '1.1' }),
					...(eventType === 'task_reordered' && { task_id: '1.1' }),
					...(eventType === 'phase_completed' && { phase_id: 1 }),
				});

				expect(event.event_type).toBe(eventType);
				expect(event.seq).toBe(i + 2); // +2 because seq 1 is plan_created
			}
		});
	});

	describe('replayFromLedger', () => {
		test('returns null when ledger is empty', async () => {
			const result = await replayFromLedger(testDir);
			expect(result).toBeNull();
		});

		test('returns null when plan.json does not exist', async () => {
			await initLedger(testDir, 'test-plan');
			const result = await replayFromLedger(testDir);
			expect(result).toBeNull();
		});

		test('replays task_status_changed events', async () => {
			// Create plan.json with initial state
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const initialPlan = {
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
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
							{
								id: '1.2',
								phase: 1,
								status: 'pending',
								size: 'medium',
								description: 'Another task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			// Initialize ledger and add events
			await initLedger(testDir, 'test-plan');

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.2',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			});

			// Replay should apply status changes
			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'in_progress',
			);
			expect(result!.phases[0].tasks.find((t) => t.id === '1.2')!.status).toBe(
				'completed',
			);
		});

		test('replays phase_completed events', async () => {
			// Create plan.json with initial state
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const initialPlan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'completed',
								size: 'small',
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
						],
					},
					{
						id: 2,
						name: 'Phase 2',
						status: 'pending',
						tasks: [
							{
								id: '2.1',
								phase: 2,
								status: 'pending',
								size: 'medium',
								description: 'Phase 2 task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'phase_completed',
				phase_id: 1,
				source: 'test',
			});

			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases.find((p) => p.id === 1)!.status).toBe('complete');
			// Phase 2 should remain unchanged
			expect(result!.phases.find((p) => p.id === 2)!.status).toBe('pending');
		});

		test('skips unknown event types with warning', async () => {
			// Create plan.json
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const initialPlan = {
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
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Append an unknown event type directly to ledger
			const ledgerPath = path.join(testDir, '.swarm', 'plan-ledger.jsonl');
			const unknownEvent: LedgerEvent = {
				seq: 2,
				timestamp: new Date().toISOString(),
				plan_id: 'test-plan',
				event_type: 'plan_exported' as any,
				source: 'test',
				plan_hash_before: 'abc',
				plan_hash_after: 'def',
				schema_version: '1.0.0',
			};
			fs.appendFileSync(
				ledgerPath,
				`${JSON.stringify(unknownEvent)}\n`,
				'utf8',
			);

			// Should not throw, should return plan with original state
			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks[0].status).toBe('pending');
		});

		test('handles multiple events in sequence', async () => {
			// Create plan.json
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const initialPlan = {
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
							{
								id: '1.2',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Task 2',
								depends: ['1.1'],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Apply events in sequence
			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				phase_id: 1,
				from_status: 'in_progress',
				to_status: 'completed',
				source: 'test',
			});

			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.2',
				phase_id: 1,
				from_status: 'pending',
				to_status: 'in_progress',
				source: 'test',
			});

			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'completed',
			);
			expect(result!.phases[0].tasks.find((t) => t.id === '1.2')!.status).toBe(
				'in_progress',
			);
		});
	});

	describe('snapshot functionality', () => {
		test('takeSnapshotEvent appends snapshot event to ledger', async () => {
			// Create plan.json before initLedger
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const initialPlan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'Test task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(initialPlan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Take snapshot event
			const snapshotEvent = await takeSnapshotEvent(testDir, initialPlan);

			// Verify the event was appended
			expect(snapshotEvent).not.toBeNull();
			expect(snapshotEvent.event_type).toBe('snapshot');
			expect(snapshotEvent.seq).toBe(2);

			// Verify the payload structure
			const payload = snapshotEvent.payload as unknown as SnapshotEventPayload;
			expect(payload.plan).toEqual(initialPlan);
			expect(payload.payload_hash).toBe(computePlanHash(initialPlan));

			// Verify the event is in the ledger
			const events = await readLedgerEvents(testDir);
			const snapshotEvents = events.filter((e) => e.event_type === 'snapshot');
			expect(snapshotEvents).toHaveLength(1);
			expect(snapshotEvents[0].seq).toBe(2);
		});

		test('replayFromLedger uses snapshot event as base when plan.json missing', async () => {
			// Create plan.json and save
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const plan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
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
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(plan), 'utf8');

			// Use the correct plan_id format matching takeSnapshotEvent's computation:
			// "${swarm}-${title}".replace(/[^a-zA-Z0-9-_]/g, '_') = 'test-swarm-Test_Plan'
			await initLedger(testDir, 'test-swarm-Test_Plan');

			// Take snapshot event
			await takeSnapshotEvent(testDir, plan);

			// Delete plan.json
			fs.unlinkSync(planJsonPath);

			// replayFromLedger should succeed using the snapshot event as base
			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'pending',
			);
		});

		test('replayFromLedger falls back to plan.json when no snapshot event exists', async () => {
			// Create plan.json
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const plan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
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
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(plan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Add events without taking snapshot event
			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			});

			// replayFromLedger should use plan.json as base (existing behavior)
			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'completed',
			);
		});

		test('replayFromLedger returns null when neither plan.json, embedded plan, nor snapshot event exists', async () => {
			// Create plan.json
			const swarmDir = path.join(testDir, '.swarm');
			const planJsonPath = path.join(swarmDir, 'plan.json');
			const plan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [],
					},
				],
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(plan), 'utf8');

			// Write a legacy-format ledger manually (no embedded plan payload)
			// to simulate the scenario where neither plan.json, snapshot event, nor
			// embedded plan is available (pre-#444 legacy ledger format).
			const ledgerPath = path.join(swarmDir, 'plan-ledger.jsonl');
			const planHash = computePlanHash(plan);
			const legacyEvent = {
				seq: 1,
				timestamp: new Date().toISOString(),
				plan_id: 'test-plan',
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

			// replayFromLedger should return null (no embedded plan, no snapshot, no plan.json)
			const result = await replayFromLedger(testDir);
			expect(result).toBeNull();
		});

		test('replayFromLedger replays deltas after snapshot event', async () => {
			// Create plan.json with task 1.1 pending
			const planJsonPath = path.join(testDir, '.swarm', 'plan.json');
			const plan: Plan = {
				schema_version: '1.0.0',
				title: 'Test Plan',
				swarm: 'test-swarm',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
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
			};
			fs.writeFileSync(planJsonPath, JSON.stringify(plan), 'utf8');

			await initLedger(testDir, 'test-plan');

			// Take snapshot event
			await takeSnapshotEvent(testDir, plan);

			// Append task_status_changed event changing 1.1 to completed
			await appendLedgerEvent(testDir, {
				plan_id: 'test-plan',
				event_type: 'task_status_changed',
				task_id: '1.1',
				from_status: 'pending',
				to_status: 'completed',
				source: 'test',
			});

			// replayFromLedger should replay deltas after snapshot event
			const result = await replayFromLedger(testDir);
			expect(result).not.toBeNull();
			expect(result!.phases[0].tasks.find((t) => t.id === '1.1')!.status).toBe(
				'completed',
			);
		});
	});
});
