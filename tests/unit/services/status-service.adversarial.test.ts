/**
 * Adversarial tests for status-service Lean Turbo state reading.
 *
 * Attack vectors:
 * 1. loadLeanTurboRunState returns null (stateUnreadable scenario)
 * 2. Run state with missing/null lanes
 * 3. Run state with invalid lane status values
 * 4. Path traversal in lane IDs / task IDs
 * 5. Script injection in degradation summaries (markdown output)
 * 6. Boundary violations (oversized numbers, negative values, massive arrays)
 * 7. Invalid turboStrategy / leanTurboActive session data
 * 8. Directory path traversal attempts
 * 9. Null bytes and control characters in strings
 * 10. Unicode/emoji in identifiers
 * 11. XSS in pause reason
 * 12. Type confusion - wrong types in run state fields
 *
 * Note: Tests mock _internals.loadLeanTurboRunState directly to avoid
 * cross-test pollution from module-level stateUnreadable flag in turbo/lean/state.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { Plan } from '../../../src/config/plan-schema';
import {
	_internals,
	formatStatusMarkdown,
	getStatusData,
} from '../../../src/services/status-service';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import type {
	LeanTurboLane,
	LeanTurboRunState,
} from '../../../src/turbo/lean/state';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_ID = 'adversarial-lean-test-session';
const mockAgents: Record<string, { name: string; config: { model: string } }> =
	{
		architect: { name: 'architect', config: { model: 'gpt-4' } },
	};

const PLAN_PHASE_1: Plan = {
	schema_version: '1.0.0',
	title: 'Adversarial Test Plan',
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

function writePlanJson(dir: string, plan: Plan): void {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	fs.writeFileSync(
		path.join(swarmDir, 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

function makeLeanRunState(
	overrides: Partial<LeanTurboRunState> = {},
): LeanTurboRunState {
	return {
		status: 'running',
		sessionID: SESSION_ID,
		strategy: 'lean',
		phase: 1,
		maxParallelCoders: 2,
		lanes: [],
		degradedTasks: [],
		counters: {
			lanesPlanned: 0,
			lanesStarted: 0,
			lanesCompleted: 0,
			lanesFailed: 0,
			tasksSerialized: 0,
			tasksDegraded: 0,
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

describe('status-service Lean Turbo adversarial tests', () => {
	let tempDir: string;
	let originalLoadLeanTurboRunState: typeof _internals.loadLeanTurboRunState;
	let originalHasActiveLeanTurbo: typeof _internals.hasActiveLeanTurbo;
	let originalHasActiveFullAuto: typeof _internals.hasActiveFullAuto;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-adversarial-'));
		writePlanJson(tempDir, PLAN_PHASE_1);

		// Save original _internals
		originalLoadLeanTurboRunState = _internals.loadLeanTurboRunState;
		originalHasActiveLeanTurbo = _internals.hasActiveLeanTurbo;
		originalHasActiveFullAuto = _internals.hasActiveFullAuto;

		// Reset swarm state and set up a clean session
		resetSwarmState();
		ensureAgentSession(SESSION_ID);

		// Set up a valid lean turbo session by default
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;
		session.fullAutoMode = false;
	});

	afterEach(() => {
		// Restore all _internals
		_internals.loadLeanTurboRunState = originalLoadLeanTurboRunState;
		_internals.hasActiveLeanTurbo = originalHasActiveLeanTurbo;
		_internals.hasActiveFullAuto = originalHasActiveFullAuto;

		// Clean up temp directory
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 1: loadLeanTurboRunState returns null (stateUnreadable)
	// -------------------------------------------------------------------------

	test('1. when loadLeanTurboRunState returns null, should not crash getStatusData', async () => {
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => null);

		const status = await getStatusData(tempDir, mockAgents);

		// lean turbo is active but no run state loaded
		expect(status.turboStrategy).toBe('lean');
		expect(status.leanTurboPhase).toBeUndefined();
		expect(status.leanActiveLaneCount).toBeUndefined();
		expect(status.leanDegradedTasks).toBeUndefined();
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 2: Run state with missing/null lanes
	// BUG FOUND: enrichWithLeanTurbo does not guard against null/undefined lanes
	// before iterating: "for (const lane of runState.lanes)" throws TypeError
	// -------------------------------------------------------------------------

	test('2. run state with null lanes — gracefully handles null lanes', async () => {
		const runState = makeLeanRunState({ lanes: null as any });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		// Fixed: now guards against null lanes and continues gracefully
		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanActiveLaneCount).toBe(0);
	});

	test('3. run state with undefined lanes — gracefully handles undefined lanes', async () => {
		const runState = makeLeanRunState({ lanes: undefined as any });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		// Fixed: now guards against undefined lanes and continues gracefully
		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanActiveLaneCount).toBe(0);
	});

	test('4. run state with empty lanes array should work normally', async () => {
		const runState = makeLeanRunState({ lanes: [] });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.leanActiveLaneCount).toBe(0);
		expect(status.leanCompletedLanes).toBe(0);
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 3: Invalid lane status values
	// -------------------------------------------------------------------------

	test('5. lane with invalid status string should only count valid statuses', async () => {
		const runState = makeLeanRunState({
			lanes: [
				{ laneId: 'lane-1', taskIds: ['1.1'], files: [], status: 'running' },
				{ laneId: 'lane-2', taskIds: ['1.2'], files: [], status: 'hacked' }, // invalid
				{ laneId: 'lane-3', taskIds: ['1.3'], files: [], status: 'completed' },
			] as LeanTurboLane[],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		// Only 'running' and 'completed' are valid, 'hacked' is ignored
		expect(status.leanActiveLaneCount).toBe(1); // only 'running'
		expect(status.leanCompletedLanes).toBe(1); // only 'completed'
	});

	test('6. lane with null status should be handled safely', async () => {
		const runState = makeLeanRunState({
			lanes: [
				{ laneId: 'lane-1', taskIds: ['1.1'], files: [], status: null as any },
			] as LeanTurboLane[],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		// null status is not 'running' or 'completed'
		expect(status.leanActiveLaneCount).toBe(0);
		expect(status.leanCompletedLanes).toBe(0);
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 4: Path traversal in lane IDs and task IDs
	// -------------------------------------------------------------------------

	test('7. lane ID with path traversal should be stored as-is', async () => {
		const runState = makeLeanRunState({
			lanes: [
				{
					laneId: '../../../etc/passwd',
					taskIds: ['1.1'],
					files: [],
					status: 'running',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		// Should not crash - lane ID is just stored
		expect(status.leanActiveLaneCount).toBe(1);
	});

	test('8. task ID with path traversal in degraded tasks should be stored as-is', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '../../../etc/passwd',
					reason: 'context_limit',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		// Degradation summary contains the malicious taskId
		expect(status.leanDegradationSummary).toContain('../../../etc/passwd');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 5: Script injection in degradation summary
	// -------------------------------------------------------------------------

	test('9. HTML script injection in degraded task reason should be stored verbatim', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1',
					reason: '<script>alert("xss")</script>',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		// The degradation summary is stored verbatim with the injection
		expect(status.leanDegradationSummary).toContain('<script>alert');
		// Note: formatStatusMarkdown only shows count, not the summary string
		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('1 degraded'); // markdown shows count
	});

	test('10. markdown formatting injection in reason should appear verbatim', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1',
					reason: '**BOLD** and _italic_ and [link](http://evil.com)',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		// The degradation summary is embedded in turbo line: "1.1 (**BOLD** and _italic_ ...)"
		expect(status.leanDegradationSummary).toContain('**BOLD**');
		expect(status.leanDegradationSummary).toContain('[link](http://evil.com)');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 6: Boundary violations
	// -------------------------------------------------------------------------

	test('11. oversized maxParallelCoders (MAX_SAFE_INTEGER) should be stored', async () => {
		const runState = makeLeanRunState({
			maxParallelCoders: Number.MAX_SAFE_INTEGER,
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanMaxParallelCoders).toBe(Number.MAX_SAFE_INTEGER);
	});

	test('12. negative maxParallelCoders should be stored as-is', async () => {
		const runState = makeLeanRunState({ maxParallelCoders: -999 });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanMaxParallelCoders).toBe(-999);
	});

	test('13. zero maxParallelCoders should be stored', async () => {
		const runState = makeLeanRunState({ maxParallelCoders: 0 });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanMaxParallelCoders).toBe(0);
	});

	test('14. massive lanes array (10,000 lanes) should not hang', async () => {
		const lanes: LeanTurboLane[] = [];
		for (let i = 0; i < 10000; i++) {
			lanes.push({
				laneId: `lane-${i}`,
				taskIds: [`${i}.1`],
				files: [`src/file-${i}.ts`],
				status: i % 2 === 0 ? 'running' : 'completed',
			});
		}
		const runState = makeLeanRunState({ lanes, maxParallelCoders: 100 });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const startTime = Date.now();
		const status = await getStatusData(tempDir, mockAgents);
		const duration = Date.now() - startTime;

		// Should complete in reasonable time
		expect(duration).toBeLessThan(5000);
		expect(status.leanActiveLaneCount).toBe(5000);
		expect(status.leanCompletedLanes).toBe(5000);
	});

	test('15. negative counter values in degradedTasks.length should not affect leanDegradedTasks', async () => {
		// Even if counters have negative values, leanDegradedTasks is derived from array length
		const runState = makeLeanRunState({
			degradedTasks: [
				{ taskId: '1.1', reason: 'a', files: [], requiredMode: 'standard' },
				{ taskId: '1.2', reason: 'b', files: [], requiredMode: 'standard' },
			],
		});
		runState.counters.tasksDegraded = -5; // doesn't matter
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		// Derived from array length, not counters
		expect(status.leanDegradedTasks).toBe(2);
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 7: Invalid session data (turboStrategy, leanTurboActive)
	// -------------------------------------------------------------------------

	test('16. when hasActiveLeanTurbo returns false, turboStrategy should be off', async () => {
		_internals.hasActiveLeanTurbo = mock(() => false);
		_internals.hasActiveFullAuto = mock(() => false);
		// loadLeanTurboRunState not called when lean turbo not active

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('off');
	});

	test('17. invalid turboStrategy (not lean or standard) should be treated as off', async () => {
		// Set session to have an invalid turboStrategy
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		// @ts-ignore - intentionally invalid value
		session.turboStrategy = 'invalid_strategy';
		session.leanTurboActive = true;

		_internals.hasActiveLeanTurbo = mock(() => false); // Won't match due to invalid strategy
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('off');
	});

	test('18. undefined leanTurboActive with lean turboStrategy should be treated as not active', async () => {
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.turboStrategy = 'lean';
		session.leanTurboActive = undefined;

		_internals.hasActiveLeanTurbo = mock(() => false);
		_internals.hasActiveFullAuto = mock(() => false);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('off');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 8: Directory path traversal
	// -------------------------------------------------------------------------

	test('19. directory with ../ path traversal should be handled gracefully', async () => {
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => null);

		// Attempt path traversal in directory parameter
		const maliciousDir = path.join(tempDir, '..', '..', '..');
		// This should not crash
		const status = await getStatusData(maliciousDir, mockAgents);

		// Should return a status object (may have no plan since dir doesn't exist properly)
		expect(typeof status.hasPlan).toBe('boolean');
	});

	test('20. empty string directory should be handled gracefully', async () => {
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => null);

		// Empty directory should be handled gracefully
		const status = await getStatusData('', mockAgents);

		expect(typeof status.hasPlan).toBe('boolean');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 9: Null bytes and control characters in strings
	// -------------------------------------------------------------------------

	test('21. null bytes in lane ID should be handled', async () => {
		const runState = makeLeanRunState({
			lanes: [
				{
					laneId: 'lane\x00with\x00nulls',
					taskIds: ['1.1'],
					files: [],
					status: 'running',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanActiveLaneCount).toBe(1);
		// String handling depends on JSON.parse - null bytes may be preserved or stripped
	});

	test('22. control characters (tabs, escapes) in reason should be preserved', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1',
					reason: 'reason\x00with\x1b[modescape\x07and\ttabs',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradationSummary).toContain('reason');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 10: Unicode and emoji in identifiers
	// -------------------------------------------------------------------------

	test('23. emoji in lane ID should be preserved', async () => {
		const runState = makeLeanRunState({
			lanes: [
				{ laneId: 'lane-🔥💀', taskIds: ['1.1'], files: [], status: 'running' },
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanActiveLaneCount).toBe(1);
	});

	test('24. zero-width space in task ID should be preserved', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1\u200b',
					reason: 'context_limit',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		// Zero-width space should be preserved
		expect(status.leanDegradationSummary).toContain('\u200b');
	});

	test('25. RTL override character in task ID should be preserved', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1\u202e malicious',
					reason: 'context_limit',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		// RTL override should be preserved
		expect(status.leanDegradationSummary).toContain('\u202e');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 11: XSS in pause reason
	// -------------------------------------------------------------------------

	test('26. XSS attempt in pause reason should appear verbatim in markdown', async () => {
		const runState = makeLeanRunState({
			status: 'paused',
			pauseReason: '<img src=x onerror="alert(1)">',
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanPauseReason).toContain('<img');
		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('<img src=x onerror');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 12: Type confusion - wrong types in run state fields
	// -------------------------------------------------------------------------

	test('27. phase as string instead of number should be handled', async () => {
		// @ts-ignore - intentionally wrong type
		const runState = makeLeanRunState({ phase: 'not-a-number' });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		// phase is stored as-is (string), but markdown formatting may not show it properly
		expect(status.leanTurboPhase).toBe('not-a-number');
	});

	test('28. maxParallelCoders as string should be stored as-is', async () => {
		// @ts-ignore - intentionally wrong type
		const runState = makeLeanRunState({ maxParallelCoders: 'many' });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanMaxParallelCoders).toBe('many');
	});

	test('29. degradedTasks as string — gracefully handles non-array value', async () => {
		// @ts-ignore - intentionally wrong type
		const runState = makeLeanRunState({ degradedTasks: 'not-an-array' });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		// Fixed: now checks Array.isArray before accessing .length
		expect(status.leanDegradedTasks).toBe(0);
	});

	test('30. pauseReason as number should be stored as-is', async () => {
		// @ts-ignore - intentionally wrong type
		const runState = makeLeanRunState({ pauseReason: 12345 });
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanPauseReason).toBe(12345);
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 13: Empty/invalid degraded task data
	// -------------------------------------------------------------------------

	test('31. empty string taskId in degraded task should show empty taskId with reason', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '',
					reason: 'context_limit',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		// Empty taskId with reason shows as " (reason)"
		expect(status.leanDegradationSummary).toBe(' (context_limit)');
	});

	test('32. empty reason in degraded task should show only taskId', async () => {
		const runState = makeLeanRunState({
			degradedTasks: [
				{
					taskId: '1.1',
					reason: '',
					files: ['src/a.ts'],
					requiredMode: 'standard',
				},
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.leanDegradedTasks).toBe(1);
		expect(status.leanDegradationSummary).toBe('1.1 ()');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 14: Very long strings
	// -------------------------------------------------------------------------

	test('33. extremely long lane ID should not crash and should complete quickly', async () => {
		const longLaneId = 'lane-' + 'x'.repeat(100000);
		const runState = makeLeanRunState({
			lanes: [
				{ laneId: longLaneId, taskIds: ['1.1'], files: [], status: 'running' },
			],
		});
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const startTime = Date.now();
		const status = await getStatusData(tempDir, mockAgents);
		const duration = Date.now() - startTime;

		expect(duration).toBeLessThan(1000);
		expect(status.leanActiveLaneCount).toBe(1);
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 15: Session ID with special characters
	// -------------------------------------------------------------------------

	test('34. session ID with path characters should not affect status', async () => {
		// Even if session ID has special chars, status should work normally
		const runState = makeLeanRunState();
		runState.sessionID = 'session/../../../etc';
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => false);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
	});

	// -------------------------------------------------------------------------
	// ATTACK VECTOR 16: Full-Auto + Lean Turbo together
	// -------------------------------------------------------------------------

	test('35. both Full-Auto and Lean Turbo active should show both in status', async () => {
		const session = swarmState.agentSessions.get(SESSION_ID)!;
		session.fullAutoMode = true;

		const runState = makeLeanRunState();
		_internals.hasActiveLeanTurbo = mock(() => true);
		_internals.hasActiveFullAuto = mock(() => true);
		_internals.loadLeanTurboRunState = mock(() => runState);

		const status = await getStatusData(tempDir, mockAgents);

		expect(status.turboStrategy).toBe('lean');
		expect(status.fullAutoActive).toBe(true);
		const markdown = formatStatusMarkdown(status);
		expect(markdown).toContain('**Full-Auto**: active');
	});
});
