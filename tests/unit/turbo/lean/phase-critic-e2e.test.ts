/**
 * Default-config E2E through a full phase (issue #2470 required test).
 *
 * Proves the phase_critic gate — default-true in turbo.lean — is satisfiable
 * through the REGISTERED lean_turbo_critic tool: with no lastCriticVerdict in
 * the run state, the only APPROVED producer is the evidence file the tool
 * writes. Before #2470 this test could not pass: no production path wrote
 * that file, so every default-config phase dead-ended at phase_complete.
 *
 * The critic dispatch is intercepted at the integration _internals seam
 * (dispatchCriticAgent); everything else — the tool wrapper, evidence write,
 * and the real verifyLeanTurboPhaseReady critic-gate read — is production
 * code. Phase-ready's non-critic seams (locks/plan/lane-evidence listing) use
 * the same mocking pattern as phase-ready.test.ts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import path from 'node:path';
import { _internals as criticIntegrationInternals } from '../../../../src/turbo/lean/integration';
import {
	_internals as phaseReadyInternals,
	verifyLeanTurboPhaseReady,
} from '../../../../src/turbo/lean/phase-ready';
import type {
	LeanTurboLane,
	LeanTurboPersistedState,
} from '../../../../src/turbo/lean/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

const _originalListActiveLocks = phaseReadyInternals.listActiveLocks;
const _originalReadPlanJson = phaseReadyInternals.readPlanJson;
const _originalListLaneEvidenceSync = phaseReadyInternals.listLaneEvidenceSync;
const _originalDispatchCriticAgent =
	criticIntegrationInternals.dispatchCriticAgent;

let dir = '';

function writeTurboState(state: LeanTurboPersistedState): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.swarm', 'turbo-state.json'),
		JSON.stringify(state),
		'utf-8',
	);
}

const LANES: LeanTurboLane[] = [
	{
		laneId: 'lane-1',
		taskIds: ['1.1', '1.2'],
		files: [],
		status: 'completed',
	},
];

/** Running session, reviewer approved in-memory, NO lastCriticVerdict. */
function leanStateWithoutCriticVerdict(): LeanTurboPersistedState {
	return {
		version: 1,
		updatedAt: '2026-01-01T00:00:00Z',
		sessions: {
			'test-session': {
				status: 'running',
				sessionID: 'test-session',
				strategy: 'lean',
				phase: 1,
				maxParallelCoders: 2,
				lanes: LANES,
				degradedTasks: [],
				serializedTasks: [],
				lastReviewerVerdict: 'APPROVED',
				counters: {
					lanesPlanned: 1,
					lanesStarted: 1,
					lanesCompleted: 1,
					lanesFailed: 0,
					tasksSerialized: 0,
					tasksDegraded: 0,
				},
			},
		},
	};
}

beforeEach(() => {
	dir = canonicalMkdtemp('phase-critic-e2e-');
	phaseReadyInternals.listActiveLocks = mock(() => []);
	phaseReadyInternals.readPlanJson = mock(() => null);
	phaseReadyInternals.listLaneEvidenceSync = mock(() =>
		LANES.filter((l) => l.status === 'completed').map((l) => l.laneId),
	);
});

afterEach(() => {
	phaseReadyInternals.listActiveLocks = _originalListActiveLocks;
	phaseReadyInternals.readPlanJson = _originalReadPlanJson;
	phaseReadyInternals.listLaneEvidenceSync = _originalListLaneEvidenceSync;
	criticIntegrationInternals.dispatchCriticAgent = _originalDispatchCriticAgent;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('default-config phase E2E: phase_critic satisfiable via lean_turbo_critic (issue #2470)', () => {
	test('without critic evidence the default-true gate blocks phase_ready', () => {
		writeTurboState(leanStateWithoutCriticVerdict());
		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});

	test('the registered lean_turbo_critic tool satisfies the default-true gate end to end', async () => {
		writeTurboState(leanStateWithoutCriticVerdict());
		criticIntegrationInternals.dispatchCriticAgent = mock(
			async (): Promise<string> =>
				'VERDICT: APPROVED\nREASON: lanes completed, diff integrated',
		);

		const { executeLeanTurboCritic } = await import(
			'../../../../src/tools/lean-turbo-critic'
		);
		// Drive the tool's execute entry (the registered surface itself is
		// asserted by lean-turbo-critic-registration.test.ts; createSwarmTool
		// routes .swarm writes through the tool context directory, so the
		// direct directory is passed explicitly here).
		const toolResult = await executeLeanTurboCritic({
			directory: dir,
			phase: 1,
			sessionID: 'test-session',
		});
		expect(toolResult.success).toBe(true);
		expect(toolResult.verdict).toBe('APPROVED');

		// The critic evidence file now exists at the convention path.
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', 'evidence', '1', 'lean-turbo-critic.json'),
			),
		).toBe(true);

		// DEFAULT config (no overrides): the gate the tool just satisfied.
		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(true);
		expect(result.reason).toBe('Phase 1 is ready to advance');
	});

	test('a REJECTED critic verdict produced through the tool keeps the gate closed', async () => {
		writeTurboState(leanStateWithoutCriticVerdict());
		criticIntegrationInternals.dispatchCriticAgent = mock(
			async (): Promise<string> =>
				'VERDICT: REJECTED\nREASON: boundary regression detected',
		);

		const { executeLeanTurboCritic } = await import(
			'../../../../src/tools/lean-turbo-critic'
		);
		const toolResult = await executeLeanTurboCritic({
			directory: dir,
			phase: 1,
			sessionID: 'test-session',
		});
		expect(toolResult.verdict).toBe('REJECTED');

		const result = verifyLeanTurboPhaseReady(dir, 1, 'test-session');
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			'Integrated critic approval missing or rejected',
		);
	});
});
