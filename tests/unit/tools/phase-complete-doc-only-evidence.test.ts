import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	recordAgentDispatch,
	recordGateEvidence,
} from '../../../src/gate-evidence';
import { swarmState } from '../../../src/state';
import { _test_exports } from '../../../src/tools/phase-complete';

describe('phase_complete doc-only durable fallback', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-doc-gate-'));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('phase review runtime prefers its immutable instance registry', () => {
		const alpha = Object.freeze([
			'alpha_reviewer',
			'alpha_critic_finding_validator',
		]);
		const beta = Object.freeze([
			'beta_reviewer',
			'beta_critic_finding_validator',
		]);
		const originalNames = swarmState.generatedAgentNames;
		try {
			swarmState.generatedAgentNames = ['global_reviewer'];
			expect([
				..._test_exports.resolvePhaseReviewAgentNames({
					generatedAgentNames: alpha,
				}),
			]).toEqual(alpha);
			expect([
				..._test_exports.resolvePhaseReviewAgentNames({
					generatedAgentNames: beta,
				}),
			]).toEqual(beta);
		} finally {
			swarmState.generatedAgentNames = originalNames;
		}
	});

	test('accepts completed reviewer-only doc evidence after restart', async () => {
		await recordAgentDispatch(directory, '1.1', 'coder', false, {
			testEngineerExempt: true,
		});
		await recordGateEvidence(directory, '1.1', 'reviewer', 'review-session');

		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				{ id: '1.1', status: 'completed' },
			]),
		).toBe(true);
	});

	test('rejects completed code evidence missing test_engineer', async () => {
		await recordAgentDispatch(directory, '1.2', 'coder');
		await recordGateEvidence(directory, '1.2', 'reviewer', 'review-session');

		expect(
			await _test_exports.allCompletedTasksHavePassedGateEvidence(directory, [
				{ id: '1.2', status: 'completed' },
			]),
		).toBe(false);
	});
});
