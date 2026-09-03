import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot.js';
import { readTaskGateRequirementsReceipts } from '../../../src/evidence/task-gate-requirements.js';
import {
	_internals as gateEvidenceInternals,
	readTaskEvidence,
	TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
} from '../../../src/gate-evidence.js';
import { resetSwarmState } from '../../../src/state.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';
const TRANSITION_ID = 'coder:issue-2525-receipt-replay';
const realAppendReceipt =
	gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded;

function writeLegacyEvidence(directory: string): void {
	const evidence: TaskEvidence = {
		taskId: TASK_ID,
		required_gates: [
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
			'designer',
		],
		gates: {},
		requirements_state: 'unknown',
		workflow: {
			schema: TASK_WORKFLOW_SCHEMA_MARKER,
			generation: 1,
			state: 'idle',
			retryCount: 0,
			retryHistory: [],
			retryEpoch: 0,
			lastOutcome: 'repair_idle',
			lastTransitionId: 'repair_gate_evidence:1.1:legacy',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
	};
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`),
		JSON.stringify(evidence, null, 2),
	);
}

function writePlan(directory: string): void {
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 2525 replay',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: TASK_ID,
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Replay missing requirements receipt',
							depends: [],
							files_touched: ['src/example.ts'],
						},
					],
				},
			],
		}),
	);
}

describe('coder settlement requirements-receipt replay (issue #2525)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('issue-2525-replay-'));
		writeLegacyEvidence(directory);
		writePlan(directory);
	});

	afterEach(() => {
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			realAppendReceipt;
		resetSwarmState();
		cleanup();
	});

	test('PREPARED replay republishes a clean receipt before committing the WAL', async () => {
		await beginCoderSettlement({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			actor: 'architect',
			expectedGeneration: 1,
			context: {
				declaredFiles: ['src/example.ts'],
				baseline: captureWorkspaceSnapshot(directory),
				workflowGeneration: 1,
			},
		});
		expect(
			(await readTaskGateRequirementsReceipts(directory, TASK_ID))[0]
				?.requiredGates,
		).toContain(TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL);

		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded = async (
			...args
		) => {
			if (
				args[0] === directory &&
				args[1] === TASK_ID &&
				args[4].type === 'accepted_mutation'
			) {
				throw new Error('injected receipt publication crash');
			}
			return realAppendReceipt(...args);
		};
		await expect(
			settleCoderDispatch({
				directory,
				taskId: TASK_ID,
				transitionId: TRANSITION_ID,
				accepted: true,
				testEngineerExempt: false,
			}),
		).rejects.toThrow('injected receipt publication crash');
		gateEvidenceInternals.appendTaskGateRequirementsReceiptIfNeeded =
			realAppendReceipt;

		const committedEvidence = await readTaskEvidence(directory, TASK_ID);
		expect(committedEvidence?.required_gates).toEqual([
			'designer',
			'reviewer',
			'test_engineer',
		]);
		expect(committedEvidence?.workflow?.generation).toBe(2);
		const beforeReplay = await readTaskGateRequirementsReceipts(
			directory,
			TASK_ID,
		);
		expect(beforeReplay).toHaveLength(1);
		expect(beforeReplay[0]?.requiredGates).toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);
		const evidencePath = path.join(
			directory,
			'.swarm',
			'evidence',
			`${TASK_ID}.json`,
		);
		const evidenceBeforeRepair = fs.readFileSync(evidencePath, 'utf8');
		const refusedRepair = JSON.parse(
			await TOOL_MANIFEST.repair_gate_evidence().execute(
				{ task_id: TASK_ID, reason: 'do not demote clean settled evidence' },
				{
					directory,
					agent: 'architect',
					sessionID: 'issue-2525-replay',
				} as ToolContext,
			),
		) as { success: boolean; message: string; errors?: string[] };
		expect(refusedRepair.success).toBe(false);
		expect(JSON.stringify(refusedRepair)).toContain(
			'CODER_SETTLEMENT_IN_PROGRESS',
		);
		expect(fs.readFileSync(evidencePath, 'utf8')).toBe(evidenceBeforeRepair);
		expect(await readTaskGateRequirementsReceipts(directory, TASK_ID)).toEqual(
			beforeReplay,
		);

		const replay = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			accepted: true,
			testEngineerExempt: false,
		});
		expect(replay.alreadyApplied).toBe(true);
		const repairedReceipts = await readTaskGateRequirementsReceipts(
			directory,
			TASK_ID,
		);
		expect(repairedReceipts).toHaveLength(2);
		expect(repairedReceipts.at(-1)?.requiredGates).toEqual([
			'designer',
			'reviewer',
			'test_engineer',
		]);

		const secondReplay = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			accepted: true,
			testEngineerExempt: false,
		});
		expect(secondReplay.alreadyApplied).toBe(true);
		expect(
			await readTaskGateRequirementsReceipts(directory, TASK_ID),
		).toHaveLength(2);
	});

	test('no-mutation replay does not append a redundant requirements receipt', async () => {
		await beginCoderSettlement({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			actor: 'architect',
			expectedGeneration: 1,
			context: {
				declaredFiles: ['src/example.ts'],
				baseline: captureWorkspaceSnapshot(directory),
				workflowGeneration: 1,
			},
		});
		const beforeSettlement = await readTaskGateRequirementsReceipts(
			directory,
			TASK_ID,
		);
		expect(beforeSettlement).toHaveLength(1);

		await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			accepted: false,
			testEngineerExempt: false,
		});
		const replay = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId: TRANSITION_ID,
			accepted: false,
			testEngineerExempt: false,
		});
		expect(replay.alreadyApplied).toBe(true);
		expect(await readTaskGateRequirementsReceipts(directory, TASK_ID)).toEqual(
			beforeSettlement,
		);
	});
});
