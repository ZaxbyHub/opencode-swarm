import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

/**
 * The tests_run catch-22 (2026-11-25, consumer task 2.20): with THREE required
 * gates (critic_sounding_board + reviewer + test_engineer, grown from the
 * escalation history), whichever Stage-B gate bound second used to jump the
 * workflow straight to tests_run — the `routeComplete === true` shortcut in
 * the stage_b_completed reducer case bypassed the required-gate count. The
 * completion guard then blocked the still-missing gate's dispatch, so the
 * last gate could never bind (every order tested live: SB→reviewer→TE,
 * SB→TE→reviewer). The reducer now counts: tests_run only when EVERY required
 * gate has bound evidence — and a gate_recorded event that completes the
 * required set performs the same transition so a receipt binding LAST can
 * still finish the sequence.
 */
describe('gate-evidence tests_run required-gates counting (catch-22)', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(path.join(canonicalTmpDir(), 'tests-run-count-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Seeds a coder task at pre_check_passed with the default Stage-B pair
	 * required: accepted_mutation(coder) → stage_a_passed.
	 */
	async function seedCoderTaskAtPreCheck(
		taskId: string,
		exempt = false,
	): Promise<void> {
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'accepted_mutation',
			agentType: 'coder',
			...(exempt ? { context: { testEngineerExempt: true } } : {}),
			expectedGeneration: 0,
			transitionId: `mut:${taskId}`,
		});
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_a_passed',
			expectedGeneration: 1,
			transitionId: `stage-a:${taskId}`,
		});
	}

	async function recordGate(
		taskId: string,
		gate: string,
		transitionId: string,
		routeComplete?: boolean,
	): Promise<void> {
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'stage_b_completed',
			gate,
			sessionId: `sess-${gate}`,
			...(routeComplete === undefined ? {} : { routeComplete }),
			expectedGeneration: 1,
			transitionId,
		});
	}

	async function recordAdvisoryGate(
		taskId: string,
		gate: string,
		transitionId: string,
	): Promise<void> {
		await transitionTaskWorkflowEvidence(tempDir, taskId, {
			type: 'gate_recorded',
			gate,
			sessionId: `sess-${gate}`,
			expectedGeneration: 1,
			transitionId,
		});
	}

	const stateOf = (taskId: string) =>
		readTaskEvidenceRaw(tempDir, taskId)?.workflow?.state;

	it('SB→reviewer→TE: a complete route on the second binding no longer jumps to tests_run; the TE completes it', async () => {
		await seedCoderTaskAtPreCheck('2.1');
		await recordAdvisoryGate('2.1', 'critic_sounding_board', 'sb:2.1');
		expect(readTaskEvidenceRaw(tempDir, '2.1')?.required_gates).toEqual([
			'critic_sounding_board',
			'reviewer',
			'test_engineer',
		]);

		// The live wedge: reviewer binding with a COMPLETE route used to
		// reach tests_run here with TE still required and unbound.
		await recordGate('2.1', 'reviewer', 'rev:2.1', true);
		expect(stateOf('2.1')).toBe('reviewer_run');

		await recordGate('2.1', 'test_engineer', 'te:2.1', true);
		expect(stateOf('2.1')).toBe('tests_run');
	});

	it('SB→TE→reviewer: the mirror order — the reviewer completes the set', async () => {
		await seedCoderTaskAtPreCheck('2.2');
		await recordAdvisoryGate('2.2', 'critic_sounding_board', 'sb:2.2');

		await recordGate('2.2', 'test_engineer', 'te:2.2', true);
		expect(stateOf('2.2')).toBe('reviewer_run');

		await recordGate('2.2', 'reviewer', 'rev:2.2', true);
		expect(stateOf('2.2')).toBe('tests_run');
	});

	it('reviewer→TE→SB (SB not yet in required_gates): the pair completes to tests_run; a late SB receipt binds without moving the state backwards', async () => {
		await seedCoderTaskAtPreCheck('2.3');

		await recordGate('2.3', 'reviewer', 'rev:2.3', true);
		expect(stateOf('2.3')).toBe('reviewer_run');

		// required_gates is still [reviewer, test_engineer] here — the
		// sounding-board receipt grows the set only through its own event
		// (the production growth shape), so the pair legitimately completes
		// to tests_run. The SB DISPATCH at this point is the guard half of
		// the fix (canRunWhileTaskAwaitsCompletion permits a still-unbound
		// gate agent); this reducer-level test pins that the late receipt
		// then binds durably and the state never demotes.
		await recordGate('2.3', 'test_engineer', 'te:2.3', true);
		expect(stateOf('2.3')).toBe('tests_run');

		await recordAdvisoryGate('2.3', 'critic_sounding_board', 'sb:2.3');
		expect(readTaskEvidenceRaw(tempDir, '2.3')?.required_gates).toEqual([
			'critic_sounding_board',
			'reviewer',
			'test_engineer',
		]);
		expect(
			readTaskEvidenceRaw(tempDir, '2.3')?.gates.critic_sounding_board,
		).toBeDefined();
		expect(stateOf('2.3')).toBe('tests_run');
	});

	it('exempt single-gate task: a complete route still reaches tests_run at the reviewer binding (regression pin)', async () => {
		await seedCoderTaskAtPreCheck('2.4', true);
		expect(readTaskEvidenceRaw(tempDir, '2.4')?.required_gates).toEqual([
			'reviewer',
		]);

		await recordGate('2.4', 'reviewer', 'rev:2.4', true);
		expect(stateOf('2.4')).toBe('tests_run');
	});

	it('default pair task: reviewer alone (route complete) stays at reviewer_run; TE completes it (count, not shortcut)', async () => {
		await seedCoderTaskAtPreCheck('2.5');

		await recordGate('2.5', 'reviewer', 'rev:2.5', true);
		expect(stateOf('2.5')).toBe('reviewer_run');

		await recordGate('2.5', 'test_engineer', 'te:2.5', true);
		expect(stateOf('2.5')).toBe('tests_run');
	});

	it('advisory-only required set (settlement-recovered task, no Stage-B gate required): a lone SB receipt stays state-preserving', async () => {
		// A settlement-recovered task reaches pre_check_passed from idle
		// without any accepted_mutation, so required_gates is empty until
		// the first gate event. The lone sounding-board receipt then grows
		// the set to just ['critic_sounding_board'] — advisory-only. The
		// completion arm must NOT fire (no Stage-B gate in the required
		// set): the state-preserving contract for advisory gates holds.
		await transitionTaskWorkflowEvidence(tempDir, '2.6', {
			type: 'stage_a_passed',
			settlementRecovery: true,
			expectedGeneration: 0,
			transitionId: 'settlement-recovery:2.6',
		});
		await transitionTaskWorkflowEvidence(tempDir, '2.6', {
			type: 'gate_recorded',
			gate: 'critic_sounding_board',
			sessionId: 'sess-critic_sounding_board',
			expectedGeneration: 0,
			transitionId: 'sb:2.6',
		});
		expect(readTaskEvidenceRaw(tempDir, '2.6')?.required_gates).toEqual([
			'critic_sounding_board',
		]);
		expect(stateOf('2.6')).toBe('pre_check_passed');
	});

	it('tests_run never moves backwards: a post-completion advisory receipt keeps the state', async () => {
		await seedCoderTaskAtPreCheck('2.7');
		await recordGate('2.7', 'reviewer', 'rev:2.7', true);
		await recordGate('2.7', 'test_engineer', 'te:2.7', true);
		expect(stateOf('2.7')).toBe('tests_run');

		// A later advisory receipt (docs) grows the required set and binds
		// itself — the count stays complete, and even if it were not, the
		// state must not demote from tests_run.
		await recordAdvisoryGate('2.7', 'docs', 'docs:2.7');
		expect(stateOf('2.7')).toBe('tests_run');
	});
});
