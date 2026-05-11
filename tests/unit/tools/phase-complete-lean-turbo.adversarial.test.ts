/**
 * Adversarial tests for Lean Turbo phase readiness gate in phase_complete.
 *
 * Tests use REAL verifyLeanTurboPhaseReady (no mocks) to validate actual
 * behavior against real file states. The Lean Turbo gate is tested by
 * setting up the session with leanTurboActive=true and writing specific
 * turbo-state.json contents.
 *
 * Adversarial vectors:
 * - Corrupt turbo-state.json (malformed JSON, wrong shape, missing keys)
 * - No active Lean Turbo session for target phase
 * - Lane status 'pending' or 'running' blocks
 * - Lane status 'failed' allows completion (per phase-ready spec)
 * - Degraded task not in lane plan and not completed in plan.json
 * - Missing reviewer/critic approval
 * - Empty lanes array
 * - Session status 'paused' (not 'running')
 * - Strategy 'standard' (not 'lean') despite leanTurboActive=true
 * - Standard Turbo active + Lean Turbo active → bypass wins
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import { _internals as leanPhaseInternals } from '../../../src/turbo/lean/phase-ready';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../src/turbo/lean/state';
import { writePersisted } from '../../../src/turbo/lean/state';

const { phase_complete } = await import('../../../src/tools/phase-complete');

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Lean Turbo Adversarial Test Plan';

function setupSwarmDir(dir: string): void {
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });

	const planJson = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'pending',
				type: 'non-code',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						description: 'Test task',
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
						description: 'Test task 2',
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson),
	);

	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			phase_complete: {
				enabled: true,
				required_agents: ['coder'],
				require_docs: false,
				policy: 'enforce',
			},
			curator: { enabled: false },
		}),
	);
}

function writeRetroBundle(dir: string, phase: number): void {
	const retroDir = path.join(dir, '.swarm', 'evidence', `retro-${phase}`);
	fs.mkdirSync(retroDir, { recursive: true });
	fs.writeFileSync(
		path.join(retroDir, 'evidence.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			task_id: `retro-${phase}`,
			entries: [
				{
					task_id: `retro-${phase}`,
					type: 'retrospective',
					timestamp: new Date().toISOString(),
					agent: 'architect',
					verdict: 'pass',
					summary: 'Phase retrospective',
					phase_number: phase,
					total_tool_calls: 10,
					coder_revisions: 1,
					reviewer_rejections: 0,
					test_failures: 0,
					security_findings: 0,
					integration_issues: 0,
					task_count: 1,
					task_complexity: 'simple',
					top_rejection_reasons: [],
					lessons_learned: [],
				},
			],
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		}),
	);
}

function writeDriftEvidence(
	dir: string,
	phase: number,
	verdict = 'approved',
): void {
	const evidenceDir = path.join(dir, '.swarm', 'evidence', String(phase));
	fs.mkdirSync(evidenceDir, { recursive: true });
	fs.writeFileSync(
		path.join(evidenceDir, 'drift-verifier.json'),
		JSON.stringify({
			entries: [
				{
					type: 'drift-verification',
					verdict,
					summary: 'Drift check',
					timestamp: new Date().toISOString(),
				},
			],
		}),
	);
}

function writeValidTurboState(
	dir: string,
	phase: number,
	lanes: LeanTurboLane[],
	overrides?: Partial<LeanTurboPersistedState['sessions'][string]>,
): void {
	const turboDir = path.join(dir, '.swarm');
	fs.mkdirSync(turboDir, { recursive: true });

	const persisted: LeanTurboPersistedState = {
		version: 1,
		updatedAt: new Date().toISOString(),
		sessions: {
			sess1: {
				status: 'running',
				sessionID: 'sess1',
				strategy: 'lean',
				phase,
				maxParallelCoders: 2,
				lanes,
				degradedTasks: [],
				lastReviewerVerdict: 'APPROVED',
				lastCriticVerdict: 'APPROVED',
				counters: {
					lanesPlanned: lanes.length,
					lanesStarted: lanes.length,
					lanesCompleted: lanes.filter((l) => l.status === 'completed').length,
					lanesFailed: lanes.filter((l) => l.status === 'failed').length,
					tasksSerialized: 1,
					tasksDegraded: 0,
				},
				...overrides,
			},
		},
	};

	fs.writeFileSync(
		path.join(turboDir, 'turbo-state.json'),
		JSON.stringify(persisted, null, 2),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase_complete — Lean Turbo adversarial', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'lean-turbo-adversarial-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupSwarmDir(tempDir);
		writeRetroBundle(tempDir, 1);
		writeDriftEvidence(tempDir, 1);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		// Ensure turbo mode is ON so hasActiveLeanTurbo() returns true for lean sessions
		swarmState.agentSessions.get('sess1')!.turboMode = true;
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'lean';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
		closeAllProjectDbs();
		resetSwarmState();
	});

	// -------------------------------------------------------------------------
	// A1: turbo-state.json corrupt JSON → blocked
	// -------------------------------------------------------------------------

	test('A1. turbo-state.json corrupt JSON → blocked', async () => {
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(turboPath, '{ "this is": "not valid json }');

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A2: turbo-state.json is array instead of object → blocked
	// -------------------------------------------------------------------------

	test('A2. turbo-state.json is array instead of object → blocked', async () => {
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(turboPath, JSON.stringify([{ sessions: {} }]));

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A3: turbo-state.json missing 'sessions' key → blocked
	// -------------------------------------------------------------------------

	test('A3. turbo-state.json missing sessions key → blocked', async () => {
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(
			turboPath,
			JSON.stringify({ version: 1, updatedAt: new Date().toISOString() }),
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A4: No active Lean Turbo session for target phase → blocked
	// -------------------------------------------------------------------------

	test('A4. No running Lean Turbo session for phase → blocked', async () => {
		// Write turbo-state with a session for a DIFFERENT phase
		writeValidTurboState(tempDir, 99, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'completed',
			},
		]);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
	});

	// -------------------------------------------------------------------------
	// A5: Lane status 'failed' → phase completes (treated as completed per spec)
	// -------------------------------------------------------------------------

	test('A5. Lane status "failed" → phase completes (treated as completed)', async () => {
		// Per phase-ready.ts line 242: 'failed' is treated as completed
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'failed',
			},
		]);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	// -------------------------------------------------------------------------
	// A6: Lane status 'pending' → blocked
	// -------------------------------------------------------------------------

	test('A6. Lane status "pending" → blocked', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'pending',
			},
		]);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A7: Lane status 'running' → blocked
	// -------------------------------------------------------------------------

	test('A7. Lane status "running" → blocked', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'running',
			},
		]);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A8: Degraded task not in lane plan and not completed in plan.json → blocked
	// -------------------------------------------------------------------------

	test('A8. Degraded task not in lane and not completed in plan.json → blocked', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: [], // Empty — degraded task is NOT in any lane
				files: [],
				status: 'completed',
			},
		]);

		// Override degradedTasks to include a task not in plan.json
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		const state = JSON.parse(fs.readFileSync(turboPath, 'utf-8'));
		state.sessions.sess1.degradedTasks = [
			{
				taskId: 'nonexistent-task',
				reason: 'Degraded due to conflict',
				files: [],
				requiredMode: 'standard',
			},
		];
		fs.writeFileSync(turboPath, JSON.stringify(state, null, 2));

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A9: Missing reviewer approval → blocked
	// -------------------------------------------------------------------------

	test('A9. Missing reviewer approval → blocked', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ lastReviewerVerdict: undefined },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A10: Missing critic approval → blocked
	// -------------------------------------------------------------------------

	test('A10. Missing critic approval → blocked', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ lastCriticVerdict: undefined },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A11: Reviewer verdict is 'REJECTED' → blocked
	// -------------------------------------------------------------------------

	test('A11. Reviewer verdict REJECTED → blocked', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ lastReviewerVerdict: 'REJECTED' },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A12: Empty lanes array → blocked
	// -------------------------------------------------------------------------

	test('A12. Empty lanes array → blocked', async () => {
		writeValidTurboState(tempDir, 1, []);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A13: Session status is 'paused' (not 'running') → blocked
	// -------------------------------------------------------------------------

	test('A13. Session status "paused" → blocked (not running)', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ status: 'paused' },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A14: Strategy is 'standard' (not 'lean') → lean turbo gate NOT activated
	// -------------------------------------------------------------------------

	test('A14. Strategy "standard" with leanTurboActive=true → lean turbo gate skipped', async () => {
		// hasActiveLeanTurbo checks: turboStrategy === 'lean' && leanTurboActive === true
		// Setting strategy to 'standard' means hasActiveLeanTurbo returns false
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'standard';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;

		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ strategy: 'standard' },
		);

		// Should pass because lean turbo gate is not activated
		// (strategy is 'standard', not 'lean')
		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	// -------------------------------------------------------------------------
	// A15: Both standard Turbo AND Lean Turbo active → standard Turbo bypass wins
	// -------------------------------------------------------------------------

	test('A15. Standard Turbo active + Lean Turbo active → standard Turbo bypass wins', async () => {
		// When standard turbo is active, ALL gates are bypassed including Lean Turbo
		swarmState.agentSessions.get('sess1')!.turboMode = true;
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'standard';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;

		// Phase would be blocked if Lean Turbo gate ran, but standard Turbo bypass skips it
		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		// Standard Turbo bypass → phase completes regardless of Lean Turbo state
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	// -------------------------------------------------------------------------
	// A16: Reviewer verdict is 'NEEDS_REVISION' → blocked
	// -------------------------------------------------------------------------

	test('A16. Reviewer verdict NEEDS_REVISION → blocked', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ lastReviewerVerdict: 'NEEDS_REVISION' },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A17: Critic verdict is not 'APPROVED' → blocked
	// -------------------------------------------------------------------------

	test('A17. Critic verdict not APPROVED → blocked', async () => {
		writeValidTurboState(
			tempDir,
			1,
			[
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: [],
					status: 'completed',
				},
			],
			{ lastCriticVerdict: 'REJECTED' },
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A18: turbo-state.json version mismatch → blocked
	// -------------------------------------------------------------------------

	test('A18. turbo-state.json version mismatch → blocked', async () => {
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		fs.writeFileSync(
			turboPath,
			JSON.stringify({
				version: 99, // Wrong version
				updatedAt: new Date().toISOString(),
				sessions: {},
			}),
		);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A19: Multiple lanes, one not completed → blocked
	// -------------------------------------------------------------------------

	test('A19. Multiple lanes, one not completed → blocked', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'completed',
			},
			{
				laneId: 'lane-2',
				taskIds: ['1.2'],
				files: [],
				status: 'running', // Not completed
			},
		]);

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
	});

	// -------------------------------------------------------------------------
	// A20: Degraded task in lane, lane completed → passes
	// -------------------------------------------------------------------------

	test('A20. Degraded task in completed lane → phase completes', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'completed',
			},
		]);

		// Degraded task is in lane-1, which is completed
		const turboPath = path.join(tempDir, '.swarm', 'turbo-state.json');
		const state = JSON.parse(fs.readFileSync(turboPath, 'utf-8'));
		state.sessions.sess1.degradedTasks = [
			{
				taskId: '1.1', // This task IS in lane-1
				reason: 'Degraded due to conflict',
				files: [],
				requiredMode: 'standard',
			},
		];
		fs.writeFileSync(turboPath, JSON.stringify(state, null, 2));

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		// Lane completed, degraded task is in lane → should pass
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	// -------------------------------------------------------------------------
	// A21: Active lane locks → blocked
	// -------------------------------------------------------------------------

	test('A21. Active lane lock for completed lane → blocked', async () => {
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'completed',
			},
		]);

		// Mock listActiveLocks to return an active lock for lane-1
		const originalListActiveLocks = leanPhaseInternals.listActiveLocks;
		leanPhaseInternals.listActiveLocks = () => [
			{
				filePath: 'src/somefile.ts',
				agent: 'coder',
				taskId: '1.1',
				timestamp: new Date().toISOString(),
				expiresAt: Date.now() + 5 * 60 * 1000,
				laneId: 'lane-1', // Matches the completed lane
			},
		];

		let result: { success: boolean; status: string; reason?: string };
		try {
			result = JSON.parse(
				await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
			);
		} finally {
			leanPhaseInternals.listActiveLocks = originalListActiveLocks;
		}

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
	});

	// -------------------------------------------------------------------------
	// A22: Full-Auto active without approval → blocked
	// -------------------------------------------------------------------------

	test('A22. Full-Auto active without approval evidence → blocked', async () => {
		// Setup Lean Turbo state with all approvals
		writeValidTurboState(tempDir, 1, [
			{
				laneId: 'lane-1',
				taskIds: ['1.1'],
				files: [],
				status: 'completed',
			},
		]);

		// Enable full-auto in the agent session
		swarmState.agentSessions.get('sess1')!.fullAutoMode = true;

		// Create full-auto state with running status for this session
		const faStatePath = path.join(tempDir, '.swarm', 'full-auto-state.json');
		fs.writeFileSync(
			faStatePath,
			JSON.stringify({
				version: 2,
				updatedAt: new Date().toISOString(),
				oversightSequence: 0,
				sessions: {
					sess1: {
						status: 'running',
						sessionID: 'sess1',
						mode: 'supervised',
						startedAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
						denialCounters: { consecutive: 0, total: 0 },
						denialHistory: [],
						counters: {
							architectTurns: 0,
							toolCalls: 0,
							coderDelegations: 0,
							reviewerRejections: 0,
							testFailures: 0,
							oversightChecks: 0,
							consecutiveNoProgressTurns: 0,
						},
					},
				},
			}),
		);

		// Ensure full-auto is enabled in config
		const configPath = path.join(tempDir, '.opencode', 'opencode-swarm.json');
		const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
		config.full_auto = { enabled: true };
		fs.writeFileSync(configPath, JSON.stringify(config));

		// Do NOT write any full-auto-*.json approval evidence in .swarm/evidence/1/

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);

		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('FULL_AUTO_APPROVAL_REQUIRED');
	});
});
