/**
 * Lean Turbo phase readiness gate tests for phase_complete.
 *
 * Covers:
 * - phase_complete passes when Lean Turbo is not active (standard behavior)
 * - phase_complete blocks when Lean Turbo active and phase not ready
 * - phase_complete passes when Lean Turbo active and phase ready
 * - standard Turbo bypass does NOT trigger Lean Turbo check
 *
 * Uses the _internals seam from phase-ready.ts to inject mock results for
 * verifyLeanTurboPhaseReady. The hasActiveLeanTurbo check uses real session
 * state so the session setup (turboStrategy='lean', leanTurboActive=true)
 * controls the gate activation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
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
import {
	_internals as phaseReadyInternals,
	type verifyLeanTurboPhaseReady,
} from '../../../src/turbo/lean/phase-ready';

const { phase_complete } = await import('../../../src/tools/phase-complete');

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

const PLAN_SWARM = 'mega';
const PLAN_TITLE = 'Lean Turbo Test Plan';
const PLAN_ID = `${PLAN_SWARM}-${PLAN_TITLE}`.replace(/[^a-zA-Z0-9-_]/g, '_');

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
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'completed',
						description: 'Test task',
					},
				],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(planJson, null, 2),
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
					metadata: {},
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('phase_complete — Lean Turbo phase readiness gate', () => {
	let tempDir: string;
	let originalCwd: string;
	const _originalVerifyLeanTurboPhaseReady =
		phaseReadyInternals.verifyLeanTurboPhaseReady;

	beforeEach(() => {
		resetSwarmState();
		tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'phase-complete-lean-turbo-')),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		setupSwarmDir(tempDir);
		writeRetroBundle(tempDir, 1);
		writeDriftEvidence(tempDir, 1);

		ensureAgentSession('sess1');
		recordPhaseAgentDispatch('sess1', 'coder');
		// Ensure turbo mode is off so gates run
		swarmState.agentSessions.get('sess1')!.turboMode = false;
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
		phaseReadyInternals.verifyLeanTurboPhaseReady =
			_originalVerifyLeanTurboPhaseReady;
	});

	test('1. Lean Turbo not active → phase completes (standard path)', async () => {
		// No Lean Turbo session set up — hasActiveLeanTurbo() returns false
		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	test('2. Lean Turbo active + phase not ready → blocked LEAN_TURBO_PHASE_NOT_READY', async () => {
		// Set up Lean Turbo session
		swarmState.agentSessions.get('sess1')!.turboMode = true;
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'lean';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;

		// Mock verifyLeanTurboPhaseReady to return not-ready
		phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
			ok: false,
			reason: 'Lane lane-1 is not completed (status: in_progress)',
		})) as typeof verifyLeanTurboPhaseReady;

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(false);
		expect(result.status).toBe('blocked');
		expect(result.reason).toBe('LEAN_TURBO_PHASE_NOT_READY');
		expect(result.message).toContain('Lane lane-1 is not completed');
	});

	test('3. Lean Turbo active + phase ready → phase completes', async () => {
		// Set up Lean Turbo session
		swarmState.agentSessions.get('sess1')!.turboMode = true;
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'lean';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = true;

		// Mock verifyLeanTurboPhaseReady to return ready
		phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
			ok: true,
			reason: 'Phase 1 is ready to advance',
			evidence: {
				lanes: ['lane-1'],
				degradedTasks: [],
				reviewerVerdict: 'APPROVED',
				criticVerdict: 'APPROVED',
			},
		})) as typeof verifyLeanTurboPhaseReady;

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		expect(result.success).toBe(true);
		expect(result.status).toBe('success');
	});

	test('4. standard Turbo active → Lean Turbo check does NOT fire (bypass path)', async () => {
		// Standard Turbo bypass — hasActiveTurboMode is true, so all gates including
		// Lean Turbo readiness gate are skipped.
		swarmState.agentSessions.get('sess1')!.turboMode = true;
		swarmState.agentSessions.get('sess1')!.turboStrategy = 'standard';
		swarmState.agentSessions.get('sess1')!.leanTurboActive = false;

		// If Lean Turbo check ran, this mock would cause a false failure.
		// Since it doesn't run, phase should complete successfully.
		phaseReadyInternals.verifyLeanTurboPhaseReady = mock(() => ({
			ok: false,
			reason: 'Should not be called',
		})) as typeof verifyLeanTurboPhaseReady;

		const result = JSON.parse(
			await phase_complete.execute({ phase: 1, sessionID: 'sess1' }),
		);
		// Turbo bypass means phase completes without gates — success expected
		expect(result.success).toBe(true);
		// mockVerify should not have been called since Lean Turbo gate is skipped
		// when standard Turbo is active
	});
});
