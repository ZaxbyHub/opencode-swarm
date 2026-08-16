import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeCouncilEvidence } from '../../../src/council/council-evidence-writer';
import type { CouncilSynthesis } from '../../../src/council/types';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	recordAgentDispatch,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const synthesis: CouncilSynthesis = {
	taskId: '1.1',
	swarmId: 'council-run',
	timestamp: '2026-08-14T00:00:00.000Z',
	overallVerdict: 'APPROVE',
	vetoedBy: null,
	memberVerdicts: [],
	unresolvedConflicts: [],
	requiredFixes: [],
	advisoryFindings: [],
	unifiedFeedbackMd: '',
	roundNumber: 1,
	allCriteriaMet: true,
	quorumSize: 3,
	blockingConcernsCount: 0,
};

describe('issue #2098 council evidence generation fencing', () => {
	let directory = '';
	let cleanup = (): void => {};

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir('council-gen-2098-'));
		fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
	});

	afterEach(() => {
		cleanup();
	});

	test('accepts the bound launch generation and rejects its stale settlement without mutating evidence', async () => {
		await recordAgentDispatch(directory, '1.1', 'coder');
		const launchGeneration = getTaskWorkflowSnapshot(
			await readTaskEvidence(directory, '1.1'),
		).generation;
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'stage_a_passed',
			expectedGeneration: launchGeneration,
			transitionId: 'stage-a-for-council',
		});

		await writeCouncilEvidence(
			directory,
			synthesis,
			'council-attempt-1',
			launchGeneration,
		);
		const accepted = await readTaskEvidence(directory, '1.1');
		expect(accepted?.gates.council).toMatchObject({
			verdict: 'APPROVE',
			workflowGeneration: launchGeneration,
			attemptId: 'council-attempt-1',
		});

		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: launchGeneration,
			transitionId: 'new-coder-generation',
		});
		const evidencePath = path.join(directory, '.swarm', 'evidence', '1.1.json');
		const beforeStaleSettlement = fs.readFileSync(evidencePath, 'utf8');

		await expect(
			writeCouncilEvidence(
				directory,
				{ ...synthesis, roundNumber: 2 },
				'council-attempt-stale',
				launchGeneration,
			),
		).rejects.toThrow('TASK_COUNCIL_GENERATION_MISMATCH');
		expect(fs.readFileSync(evidencePath, 'utf8')).toBe(beforeStaleSettlement);
		expect(
			getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')),
		).toMatchObject({ state: 'coder_delegated', generation: 2 });
	});
});
