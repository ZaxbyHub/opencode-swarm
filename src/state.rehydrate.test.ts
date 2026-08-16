import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentSessionState, TaskWorkflowState } from './state';
import {
	rehydrateSessionFromDisk,
	resetSwarmState,
	startAgentSession,
	swarmState,
} from './state';

let tmpDir: string;
let testSessionId: string;

beforeEach(() => {
	resetSwarmState();
	tmpDir = mkdtempSync(path.join(os.tmpdir(), 'rehydrate-test-'));
	mkdirSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
	testSessionId = `test-session-${Date.now()}`;
});

afterEach(() => {
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
	swarmState.agentSessions.delete(testSessionId);
});

// Helper to create a session and get the actual session from the map
function createTestSession(): AgentSessionState {
	startAgentSession(testSessionId, 'architect');
	const session = swarmState.agentSessions.get(testSessionId);
	if (!session) {
		throw new Error('Failed to create test session');
	}
	return session;
}

// Helper to create plan.json content
function writePlan(
	tasks: Array<{ id: string; status: string }>,
	phases = 1,
): void {
	// Parse phase number from task id (e.g., "1.1" -> phase 1)
	const getPhase = (taskId: string): number => {
		const dotIndex = taskId.indexOf('.');
		return parseInt(taskId.substring(0, dotIndex), 10);
	};

	const plan = {
		schema_version: '1.0.0' as const,
		title: 'Test Plan',
		swarm: 'test',
		phases: Array.from({ length: phases }, (_, pi) => ({
			id: pi + 1,
			name: `Phase ${pi + 1}`,
			status: 'pending' as const,
			tasks: tasks
				.filter((t) => getPhase(t.id) === pi + 1)
				.map((t) => ({
					id: t.id,
					phase: getPhase(t.id),
					description: `Task ${t.id}`,
					status: t.status,
					size: 'small' as const,
					depends: [],
					files_touched: [],
				})),
		})),
	};
	writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), JSON.stringify(plan));
}

// Helper to create evidence file
function writeEvidence(
	taskId: string,
	gates: Record<string, unknown>,
	required_gates: string[],
): void {
	const normalizedGates = Object.fromEntries(
		Object.entries(gates).map(([gate, value]) => [
			gate,
			{
				sessionId: `session-${gate}`,
				timestamp: '2026-08-14T00:00:00.000Z',
				agent: gate,
				...(typeof value === 'object' && value !== null ? value : {}),
			},
		]),
	) as Record<string, Record<string, unknown>>;
	const gateNames = new Set(Object.keys(normalizedGates));
	const generation = gateNames.size > 0 ? 1 : 0;
	const state: TaskWorkflowState = gateNames.has('council')
		? 'pre_check_passed'
		: gateNames.has('test_engineer')
			? 'tests_run'
			: gateNames.has('reviewer')
				? 'reviewer_run'
				: gateNames.has('coder')
					? 'coder_delegated'
					: 'idle';
	if (normalizedGates.council) {
		normalizedGates.council.workflowGeneration = generation;
	}
	const evidence = {
		taskId,
		required_gates,
		gates: normalizedGates,
		workflow: {
			schema: 'exact-task-v1',
			generation,
			state,
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: state === 'idle' ? 'none' : 'gate_recorded',
			lastTransitionId: null,
			updatedAt: '2026-08-14T00:00:00.000Z',
		},
	};
	writeFileSync(
		path.join(tmpDir, '.swarm', 'evidence', `${taskId}.json`),
		JSON.stringify(evidence),
	);
}

// State order for comparison
const STATE_ORDER: TaskWorkflowState[] = [
	'idle',
	'coder_delegated',
	'pre_check_passed',
	'reviewer_run',
	'tests_run',
	'complete',
];

function _getStateIndex(state: TaskWorkflowState): number {
	return STATE_ORDER.indexOf(state);
}

describe('rehydrateSessionFromDisk', () => {
	// ── HAPPY PATH ────────────────────────────────────────────────────────────

	it('1. reads plan.json and sets workflow states from plan status', async () => {
		// Arrange: plan with tasks in various states
		writePlan([
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'completed' },
			{ id: '1.3', status: 'pending' },
		]);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Plan intent alone does not prove an accepted coder mutation.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
		expect(session.taskWorkflowStates!.get('1.2')).toBe('complete');
		expect(session.taskWorkflowStates!.get('1.3')).toBe('idle');
	});

	it('2. reads evidence files and sets workflow states from evidence', async () => {
		// Arrange: plan with in_progress, but evidence shows reviewer passed
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeEvidence(
			'1.1',
			{ reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' } },
			['reviewer', 'test_engineer'],
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: evidence should win -> reviewer_run
		expect(session.taskWorkflowStates!.get('1.1')).toBe('reviewer_run');
	});

	// ── EVIDENCE > PLAN PRIORITY ─────────────────────────────────────────────

	it('3. evidence-derived state wins over plan-only state', async () => {
		// Arrange: plan says pending (idle), but evidence shows test_engineer passed
		writePlan([{ id: '1.1', status: 'pending' }]);
		writeEvidence(
			'1.1',
			{
				reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' },
				test_engineer: {
					sessionId: 's2',
					timestamp: 't2',
					agent: 'test_engineer',
				},
			},
			['reviewer', 'test_engineer'],
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Stage B evidence is non-terminal until the central terminal transaction.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('tests_run');
	});

	it('4. all required Stage B gates rehydrate as tests_run, not terminal', async () => {
		// Arrange: plan says pending, evidence shows all gates passed
		writePlan([{ id: '1.1', status: 'pending' }]);
		writeEvidence(
			'1.1',
			{
				reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' },
				test_engineer: {
					sessionId: 's2',
					timestamp: 't2',
					agent: 'test_engineer',
				},
			},
			['reviewer', 'test_engineer'],
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Passing gates reaches tests_run; completion is a separate transaction.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('tests_run');
	});

	// ── NO DOWNGRADE OF IN-MEMORY STATE ───────────────────────────────────────

	it('5. existing in-memory state is NOT downgraded by disk state', async () => {
		// Arrange: plan says pending (idle), but session already has tests_run
		writePlan([{ id: '1.1', status: 'pending' }]);
		// No evidence file

		const session = createTestSession();
		session.taskWorkflowStates!.set('1.1', 'tests_run'); // Already at tests_run

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: in-memory tests_run should be preserved (not downgraded to idle)
		expect(session.taskWorkflowStates!.get('1.1')).toBe('tests_run');
	});

	it('6. in-memory state is upgraded when disk has higher state', async () => {
		// Arrange: session has coder_delegated, disk has reviewer_run (via evidence)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeEvidence(
			'1.1',
			{ reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' } },
			['reviewer', 'test_engineer'],
		);

		const session = createTestSession();
		session.taskWorkflowStates!.set('1.1', 'coder_delegated');

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: should be upgraded to reviewer_run
		expect(session.taskWorkflowStates!.get('1.1')).toBe('reviewer_run');
	});

	it('7. in-memory complete is preserved even if disk shows earlier state', async () => {
		// Arrange: session has complete, disk has coder_delegated
		writePlan([{ id: '1.1', status: 'in_progress' }]); // plan intent -> idle

		const session = createTestSession();
		session.taskWorkflowStates!.set('1.1', 'complete');

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: complete should be preserved
		expect(session.taskWorkflowStates!.get('1.1')).toBe('complete');
	});

	// ── NON-FATAL ON MISSING/MALFORMED DATA ───────────────────────────────────

	it('8. missing plan.json is non-fatal (no change)', async () => {
		// Arrange: no plan.json
		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no tasks should be added
		expect(session.taskWorkflowStates!.size).toBe(0);
	});

	it('9. missing evidence directory is non-fatal', async () => {
		// Arrange: plan exists, but no evidence dir
		rmSync(path.join(tmpDir, '.swarm', 'evidence'), { recursive: true });
		writePlan([{ id: '1.1', status: 'in_progress' }]);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Plan state is intent only; no durable accepted mutation exists.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	it('10. malformed plan.json is non-fatal', async () => {
		// Arrange: invalid JSON
		writeFileSync(path.join(tmpDir, '.swarm', 'plan.json'), 'invalid json{{{');

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no tasks should be added
		expect(session.taskWorkflowStates!.size).toBe(0);
	});

	it('11. malformed evidence file is skipped (non-fatal)', async () => {
		// Arrange: valid plan, malformed evidence file
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			'not valid json{{{',
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: should fall back to non-authoritative plan intent.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	it('12. evidence file without required_gates is skipped', async () => {
		// Arrange: evidence missing required_gates field
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({ taskId: '1.1', gates: {} }),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: should fall back to non-authoritative plan intent.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	it('13. evidence file with invalid taskId format is skipped', async () => {
		// Arrange: evidence file with invalid taskId (should not match /^\d+\.\d+(\.\d+)*$/)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', 'invalid-task.json'),
			JSON.stringify({ taskId: 'invalid', required_gates: [], gates: {} }),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: should use plan intent for 1.1.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	// ── EDGE CASES ─────────────────────────────────────────────────────────────

	it('14. multiple phases with multiple tasks are all processed', async () => {
		// Arrange: 2 phases, multiple tasks
		writePlan(
			[
				{ id: '1.1', status: 'in_progress' },
				{ id: '1.2', status: 'completed' },
				{ id: '2.1', status: 'pending' },
				{ id: '2.2', status: 'in_progress' },
			],
			2,
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: all tasks should be present
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
		expect(session.taskWorkflowStates!.get('1.2')).toBe('complete');
		expect(session.taskWorkflowStates!.get('2.1')).toBe('idle');
		expect(session.taskWorkflowStates!.get('2.2')).toBe('idle');
	});

	it('15. taskWorkflowStates is initialized if missing', async () => {
		// Arrange: session without taskWorkflowStates
		const session = createTestSession();
		// @ts-expect-error - intentionally missing taskWorkflowStates for test
		delete session.taskWorkflowStates;

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: should have been initialized
		expect(session.taskWorkflowStates).toBeDefined();
		expect(session.taskWorkflowStates).toBeInstanceOf(Map);
	});

	it('16. empty plan with no phases is handled', async () => {
		// Arrange: plan with empty phases array
		writeFileSync(
			path.join(tmpDir, '.swarm', 'plan.json'),
			JSON.stringify({ title: 'Empty', swarm_id: 'test', phases: [] }),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no tasks should be added
		expect(session.taskWorkflowStates!.size).toBe(0);
	});

	it('17. evidence gates without test_engineer results in tests_run state', async () => {
		// Arrange: evidence shows only coder gate (gates object has entries but no test_engineer)
		writePlan([{ id: '1.1', status: 'pending' }]);
		writeEvidence(
			'1.1',
			{ coder: { sessionId: 's1', timestamp: 't1', agent: 'coder' } },
			['reviewer', 'test_engineer'],
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: coder gate present -> coder_delegated
		expect(session.taskWorkflowStates!.get('1.1')).toBe('coder_delegated');
	});

	it('18. path traversal in evidence filename is blocked', async () => {
		// Arrange: try to create evidence file with path traversal
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		// This should be filtered out by the validation regex
		mkdirSync(path.join(tmpDir, '.swarm', 'evidence', '..'), {
			recursive: true,
		});

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: only non-authoritative plan intent should be used.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	it('19. empty gates object in evidence results in idle state', async () => {
		// Arrange: evidence exists but has empty gates
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeEvidence('1.1', {}, ['reviewer', 'test_engineer']);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: empty gates -> idle
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
	});

	it('20. non-.json files in evidence dir are ignored', async () => {
		// Arrange: non-JSON files in evidence directory
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.txt'),
			'some text',
		);
		// Also create a .json file for a task NOT in the plan
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.2.json'),
			JSON.stringify({ taskId: '1.2', required_gates: [], gates: {} }),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: only tasks in plan should be processed; .txt files ignored
		expect(session.taskWorkflowStates!.get('1.1')).toBe('idle');
		// Task 1.2 is not in plan, so should not exist in workflow states
		expect(session.taskWorkflowStates!.has('1.2')).toBe(false);
	});
});

describe('council verdict rehydration', () => {
	// Helper to write evidence with a council gate
	function writeCouncilEvidence(
		taskId: string,
		councilData: {
			verdict?: string;
			roundNumber?: number;
			quorumSize?: number;
		},
		requiredGates: string[] = ['council'],
	): void {
		const gates: Record<string, unknown> = {};
		if (
			councilData.verdict !== undefined ||
			councilData.roundNumber !== undefined ||
			councilData.quorumSize !== undefined
		) {
			gates.council = {
				...(councilData.verdict !== undefined && {
					verdict: councilData.verdict,
				}),
				...(councilData.roundNumber !== undefined && {
					roundNumber: councilData.roundNumber,
				}),
				...(councilData.quorumSize !== undefined && {
					quorumSize: councilData.quorumSize,
				}),
			};
		}
		writeEvidence(taskId, gates, requiredGates);
	}

	// ── VERDICT REHYDRATION (HAPPY PATH) ──────────────────────────────────────

	it('1. APPROVE verdict is rehydrated correctly from evidence', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 2 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 2,
			quorumSize: 1,
		});
	});

	it('2. REJECT verdict is rehydrated correctly from evidence', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'REJECT', roundNumber: 1 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'REJECT',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('3. CONCERNS verdict is rehydrated correctly from evidence', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'CONCERNS', roundNumber: 3 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'CONCERNS',
			roundNumber: 3,
			quorumSize: 1,
		});
	});

	// ── NO COUNCIL EVIDENCE ───────────────────────────────────────────────────

	it('4. no council evidence → Map entry not created', async () => {
		// Arrange: evidence exists but no council gate
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', {}); // Empty council data = no gates.council

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: taskCouncilApproved should not have an entry for 1.1
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('5. authoritative disk verdict replaces stale in-memory verdict', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 2 });

		const session = createTestSession();
		// Pre-populate with a different verdict (simulating in-flight session)
		session.taskCouncilApproved!.set('1.1', {
			verdict: 'REJECT',
			roundNumber: 1,
			quorumSize: 3,
		});

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Durable exact-generation evidence is authoritative after restart.
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 2,
			quorumSize: 1,
		});
	});

	// ── CORRUPTED/MALFORMED DATA ──────────────────────────────────────────────

	it('6. missing verdict (undefined) is skipped silently', async () => {
		// Arrange: council gate exists but verdict is missing
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { roundNumber: 1 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('7. null verdict is skipped silently', async () => {
		// Arrange: verdict is explicitly null
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', {
			verdict: null as unknown as string,
			roundNumber: 1,
		});

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('8. non-string verdict (number) is skipped silently', async () => {
		// Arrange: verdict is a number instead of string
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', {
			verdict: 123 as unknown as string,
			roundNumber: 1,
		});

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('9. unknown verdict string ("MAYBE") is skipped', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'MAYBE', roundNumber: 1 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ROUND NUMBER DEFAULTS ─────────────────────────────────────────────────

	it('10. roundNumber defaults to 1 when missing', async () => {
		// Arrange: verdict present but roundNumber omitted
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE' }); // No roundNumber

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber should default to 1
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('11. roundNumber defaults to 1 when NaN', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: NaN });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber should default to 1
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('12. roundNumber defaults to 1 when Infinity', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: Infinity });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber should default to 1
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('13. roundNumber defaults to 1 when -Infinity', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: -Infinity });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber should default to 1
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('14. roundNumber defaults to 1 when non-number type (string)', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', {
			verdict: 'APPROVE',
			roundNumber: 'two' as unknown as number,
		});

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber should default to 1
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	// ── EDGE CASES ─────────────────────────────────────────────────────────────

	it('15. valid roundNumber 0 is preserved (falsy but valid)', async () => {
		// Arrange: roundNumber is 0 (valid finite number)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 0 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: roundNumber 0 should be preserved (Number.isFinite(0) === true)
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 0,
			quorumSize: 1,
		});
	});

	it('16. valid roundNumber 100 is preserved', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: 'CONCERNS', roundNumber: 100 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'CONCERNS',
			roundNumber: 100,
			quorumSize: 1,
		});
	});

	it('17. multiple tasks with different verdicts are all rehydrated', async () => {
		// Arrange
		writePlan([
			{ id: '1.1', status: 'in_progress' },
			{ id: '1.2', status: 'in_progress' },
			{ id: '1.3', status: 'in_progress' },
		]);
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 1 });
		writeCouncilEvidence('1.2', { verdict: 'REJECT', roundNumber: 2 });
		writeCouncilEvidence('1.3', { verdict: 'CONCERNS', roundNumber: 3 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: all three should be rehydrated
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
		expect(session.taskCouncilApproved!.get('1.2')).toEqual({
			verdict: 'REJECT',
			roundNumber: 2,
			quorumSize: 1,
		});
		expect(session.taskCouncilApproved!.get('1.3')).toEqual({
			verdict: 'CONCERNS',
			roundNumber: 3,
			quorumSize: 1,
		});
	});

	it('18. taskWorkflowStates also rehydrated alongside council verdicts', async () => {
		// Arrange: verify both workflow state (via plan status) and council verdict are rehydrated
		writePlan([{ id: '1.1', status: 'in_progress' }]); // council evidence supplies exact state
		writeEvidence(
			'1.1',
			{ council: { verdict: 'APPROVE', roundNumber: 1 } },
			[], // no required gates - council is extra data alongside plan state
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: plan-derived workflow state AND council verdict are both rehydrated
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('19. empty string verdict is skipped', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilEvidence('1.1', { verdict: '', roundNumber: 1 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	describe('quorumSize rehydration (Task 3.3)', () => {
		it('evidence with quorumSize: 4 rehydrates correctly', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeCouncilEvidence('1.1', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 4,
			});
			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);
			expect(session.taskCouncilApproved!.get('1.1')?.quorumSize).toBe(4);
		});

		it('evidence missing quorumSize defaults to 1 (conservative for old evidence)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 1 });
			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);
			expect(session.taskCouncilApproved!.get('1.1')?.quorumSize).toBe(1);
		});

		it('exact evidence with non-numeric quorumSize defaults to 1', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeCouncilEvidence('1.1', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 'invalid' as unknown as number,
			});
			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);
			expect(session.taskCouncilApproved!.get('1.1')?.quorumSize).toBe(1);
		});

		it('evidence with NaN quorumSize defaults to 1', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeCouncilEvidence('1.1', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: NaN,
			});
			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);
			// NaN does not survive JSON serialization (becomes null), so the loaded
			// value is non-numeric and falls through to the default of 1.
			expect(session.taskCouncilApproved!.get('1.1')?.quorumSize).toBe(1);
		});

		it('evidence with quorumSize: 0 defaults to 1 (must be >= 1)', async () => {
			writePlan([{ id: '1.1', status: 'in_progress' }]);
			writeCouncilEvidence('1.1', {
				verdict: 'APPROVE',
				roundNumber: 1,
				quorumSize: 0,
			});
			const session = createTestSession();
			await rehydrateSessionFromDisk(tmpDir, session);
			expect(session.taskCouncilApproved!.get('1.1')?.quorumSize).toBe(1);
		});
	});
});

describe('adversarial council verdict rehydration', () => {
	// Helper to write evidence with a council gate
	function writeCouncilEvidence(
		taskId: string,
		councilData: {
			verdict?: string;
			roundNumber?: number;
			quorumSize?: number;
		},
		requiredGates: string[] = ['council'],
	): void {
		const gates: Record<string, unknown> = {};
		if (
			councilData.verdict !== undefined ||
			councilData.roundNumber !== undefined ||
			councilData.quorumSize !== undefined
		) {
			gates.council = {
				...(councilData.verdict !== undefined && {
					verdict: councilData.verdict,
				}),
				...(councilData.roundNumber !== undefined && {
					roundNumber: councilData.roundNumber,
				}),
				...(councilData.quorumSize !== undefined && {
					quorumSize: councilData.quorumSize,
				}),
			};
		}
		writeEvidence(taskId, gates, requiredGates);
	}

	// ── ATTACK VECTOR 1: Prototype pollution via __proto__ ──────────────────

	it('1. __proto__ as verdict key does not pollute prototype', async () => {
		// Arrange: JSON with __proto__ as verdict value
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: {
						verdict: 'APPROVE',
						roundNumber: 1,
						__proto__: { isEvil: true }, // prototype pollution attempt
					},
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Legacy/unbound evidence is rejected before council rehydration.
		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
		// Verify no prototype pollution
		expect(Object.hasOwn({}, 'isEvil')).toBe(false);
	});

	// ── ATTACK VECTOR 2: Prototype pollution via constructor ───────────────

	it('2. constructor as verdict key does not create object prototype pollution', async () => {
		// Arrange: JSON with constructor as verdict value
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: {
						verdict: 'REJECT',
						roundNumber: 2,
						constructor: { prototype: { isAdmin: true } }, // constructor pollution attempt
					},
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Legacy/unbound evidence is rejected before council rehydration.
		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
		// Verify no constructor prototype pollution
		expect(Object.hasOwn({}, 'isAdmin')).toBe(false);
	});

	// ── ATTACK VECTOR 3: gates.council as array instead of object ──────────

	it('3. gates.council as array is safely skipped', async () => {
		// Arrange: council gate is an array instead of object
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: ['APPROVE', 1], // array instead of object
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (array has no .verdict/.roundNumber properties)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 4: gates.council as null ─────────────────────────────

	it('4. gates.council as null is safely skipped', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: null, // null instead of object
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 5: gates as string instead of object ─────────────────

	it('5. gates as string instead of object is safely skipped', async () => {
		// Arrange: gates is a string, not an object
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: 'not an object', // string instead of object
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (string has no .council property access that yields object)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 6: Extremely long verdict string (10000+ chars) ─────

	it('6. extremely long verdict string (>10KB) is safely rejected', async () => {
		// Arrange: verdict string is 10000+ characters
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		const longVerdict = `APPROVE${'x'.repeat(10000)}`;
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: longVerdict, roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (longVerdict is not in VALID_COUNCIL_VERDICTS)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 7: roundNumber as MAX_SAFE_INTEGER + 1 ──────────────

	it('7. unbound evidence with MAX_SAFE_INTEGER round is rejected', async () => {
		// Arrange: MAX_SAFE_INTEGER + 1 is still finite and representable in JS
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		const largeButFinite = Number.MAX_SAFE_INTEGER + 1; // 9007199254740992
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE', roundNumber: largeButFinite },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
	});

	// ── ATTACK VECTOR 8: Null byte injection in verdict ────────────────────

	it('8. verdict with null byte injection is safely rejected', async () => {
		// Arrange: verdict contains null byte (\x00)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		// Using JSON.stringify to properly encode the null byte
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE\x00EVIL', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (null-injected string not in VALID_COUNCIL_VERDICTS)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 9: gates.council as number instead of object ─────────

	it('9. gates.council as number (not object) is safely skipped', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: 42, // number instead of object
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (42 has no .verdict property)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	// ── ATTACK VECTOR 10: Multiple evidence files with same taskId (last write wins) ──

	it('10. multiple evidence files for same taskId: last file content wins', async () => {
		// Arrange: write two evidence files for same taskId (simulates race condition)
		// Note: on Windows/Linux the last write will be the final state
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		// First write APPROVE
		writeCouncilEvidence('1.1', { verdict: 'APPROVE', roundNumber: 1 });
		// Second write overwrites with REJECT
		writeCouncilEvidence('1.1', { verdict: 'REJECT', roundNumber: 2 });

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: last write (REJECT) should win (file system semantics)
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'REJECT',
			roundNumber: 2,
			quorumSize: 1,
		});
	});

	// ── ADDITIONAL ATTACK VECTORS ─────────────────────────────────────────

	it('11. verdict is "toString" (Object.prototype property) is safely rejected', async () => {
		// Arrange: verdict is hasOwnProperty - Object.prototype property
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'hasOwnProperty', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('12. verdict is "valueOf" (Object.prototype property) is safely rejected', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'valueOf', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('13. evidence with undefined verdict (JSON undefined becomes null) is safely skipped', async () => {
		// Arrange: verdict is undefined (becomes null in JSON, then cast)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { roundNumber: 1 }, // verdict is undefined in JS object, becomes null in JSON
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (undefined verdict becomes null via JSON.parse)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('14. unbound evidence with a negative round is rejected', async () => {
		// Arrange: negative roundNumber - code only checks isFinite, not positivity
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE', roundNumber: -999999999 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
	});

	it('15. unbound evidence with a very large negative round is rejected', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: {
						verdict: 'APPROVE',
						roundNumber: -Number.MAX_SAFE_INTEGER,
					},
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
	});

	it('16. verdict string with HTML/script injection patterns is safely rejected', async () => {
		// Arrange: verdict attempts XSS-like injection
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: '<script>alert(1)</script>', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('17. verdict string with template literal injection is safely rejected', async () => {
		// Arrange: verdict attempts template literal injection
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: '${console.log("pwned")}', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('18. verdict string with SQL-like injection is safely rejected', async () => {
		// Arrange: verdict attempts SQL injection
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: "'; DROP TABLE evidence; --", roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('19. verdict string with path traversal pattern is safely rejected', async () => {
		// Arrange: verdict attempts path traversal
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: '../../../etc/passwd', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('20. combined prototype pollution + XSS payload is safely handled', async () => {
		// Arrange: complex combined attack
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: {
						verdict: 'APPROVE',
						roundNumber: 1,
						__proto__: { isAdmin: true },
						constructor: { prototype: { shell: 'pwned' } },
					},
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
		expect(Object.hasOwn({}, 'isAdmin')).toBe(false);
	});

	it('21. gates.council is boolean true (truthy but not object) is safely skipped', async () => {
		// Arrange
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: true, // boolean instead of object
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created (true.verdict === undefined)
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('22. verdict string with unicode RTL override is safely rejected', async () => {
		// Arrange: verdict with RTL unicode override character
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		// U+202E RIGHT-TO-LEFT OVERRIDE
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE\u202E贰', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('24. verdict string with zero-width space is safely rejected', async () => {
		// Arrange: verdict with zero-width space (U+200B)
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE\u200B', roundNumber: 1 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: no entry created
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});

	it('25. unbound evidence with a floating-point round is rejected', async () => {
		// Arrange: roundNumber is a valid floating point number
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE', roundNumber: 1.5 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
	});

	it('26. unbound evidence with negative-zero round is rejected', async () => {
		// Arrange: roundNumber is -0
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: 'APPROVE', roundNumber: -0 },
				},
			}),
		);

		const session = createTestSession();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		expect(session.taskCouncilApproved!.get('1.1')).toBeUndefined();
	});

	it('27. taskCouncilApproved Map is initialized even when all evidence is malicious', async () => {
		// Arrange: all evidence is malicious, but session lacks taskCouncilApproved
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeFileSync(
			path.join(tmpDir, '.swarm', 'evidence', '1.1.json'),
			JSON.stringify({
				taskId: '1.1',
				required_gates: ['council'],
				gates: {
					council: { verdict: '__proto__', roundNumber: NaN },
				},
			}),
		);

		const session = createTestSession();
		// Ensure taskCouncilApproved is initialized
		expect(session.taskCouncilApproved).toBeDefined();

		// Act
		await rehydrateSessionFromDisk(tmpDir, session);

		// Assert: taskCouncilApproved Map should still be defined and empty for 1.1
		expect(session.taskCouncilApproved).toBeInstanceOf(Map);
		expect(session.taskCouncilApproved!.has('1.1')).toBe(false);
	});
});

describe('council verdict rehydration does NOT bypass Stage-A', () => {
	// Helper to write evidence with council + other gates
	function writeCouncilWithOtherGates(
		taskId: string,
		councilVerdict: string,
		allCriteriaMet: boolean,
		otherGates: Record<string, unknown> = {},
		requiredGates: string[] = [],
	): void {
		const gates: Record<string, unknown> = {
			council: {
				verdict: councilVerdict,
				allCriteriaMet,
				roundNumber: 1,
			},
			...otherGates,
		};
		writeEvidence(taskId, gates, requiredGates);
	}

	// ── REGRESSION: Council APPROVE does NOT fast-path to 'complete' ──────
	// Gate evidence (reviewer/test_engineer) is recorded at delegation time,
	// NOT after Stage A passes. Using "any non-council gate exists" as a proxy
	// for Stage-A would allow a bypass of the pastPreCheck guard.

	it('1. APPROVE + allCriteriaMet=true + reviewer gate -> NOT complete (no Stage-A bypass)', async () => {
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilWithOtherGates('1.1', 'APPROVE', true, {
			reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' },
		});
		const session = createTestSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		// Without explicit Stage-A evidence, must NOT jump to complete
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
		// But council verdict IS still recovered
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('2. APPROVE + allCriteriaMet=true + test_engineer gate -> NOT complete', async () => {
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilWithOtherGates('1.1', 'APPROVE', true, {
			test_engineer: {
				sessionId: 's1',
				timestamp: 't1',
				agent: 'test_engineer',
			},
		});
		const session = createTestSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('3. APPROVE + allCriteriaMet=true + lint gate -> NOT complete', async () => {
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilWithOtherGates('1.1', 'APPROVE', true, {
			lint: { sessionId: 's1', timestamp: 't1', agent: 'lint' },
		});
		const session = createTestSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('4. APPROVE + allCriteriaMet=true + multiple non-council gates -> NOT complete', async () => {
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilWithOtherGates('1.1', 'APPROVE', true, {
			reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' },
			test_engineer: {
				sessionId: 's2',
				timestamp: 't2',
				agent: 'test_engineer',
			},
		});
		const session = createTestSession();
		await rehydrateSessionFromDisk(tmpDir, session);
		// Even with multiple gates, no fast-path to complete
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
		expect(session.taskCouncilApproved!.get('1.1')).toEqual({
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 1,
		});
	});

	it('5. authoritative council generation replaces stale in-memory complete', async () => {
		writePlan([{ id: '1.1', status: 'in_progress' }]);
		writeCouncilWithOtherGates('1.1', 'APPROVE', true, {
			reviewer: { sessionId: 's1', timestamp: 't1', agent: 'reviewer' },
		});
		const session = createTestSession();
		session.taskWorkflowStates!.set('1.1', 'complete');
		await rehydrateSessionFromDisk(tmpDir, session);
		// A newer authoritative generation replaces stale in-memory state.
		expect(session.taskWorkflowStates!.get('1.1')).toBe('pre_check_passed');
	});
});
