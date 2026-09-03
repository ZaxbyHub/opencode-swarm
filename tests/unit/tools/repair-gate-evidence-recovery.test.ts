import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { captureWorkspaceSnapshot } from '../../../src/background/workspace-snapshot.js';
import {
	appendTaskGateRequirementsReceiptIfNeeded,
	readTaskGateRequirementsReceipts,
} from '../../../src/evidence/task-gate-requirements.js';
import {
	readTaskEvidence,
	recordGateEvidence,
	TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import { resetSwarmState } from '../../../src/state.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import {
	beginCoderSettlement,
	settleCoderDispatch,
} from '../../../src/workflow/coder-settlement.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';

function workflow(
	generation: number,
	state: 'idle' | 'coder_delegated' | 'pre_check_passed' | 'tests_run',
): NonNullable<TaskEvidence['workflow']> {
	return {
		schema: TASK_WORKFLOW_SCHEMA_MARKER,
		generation,
		state,
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: state === 'idle' ? 'repair_idle' : 'accepted_mutation',
		lastTransitionId:
			state === 'idle'
				? `repair_gate_evidence:${TASK_ID}:legacy`
				: `issue-2525-${state}`,
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

function proof(agent: string) {
	return {
		sessionId: `issue-2525-${agent}`,
		timestamp: '2026-01-01T00:00:00.000Z',
		agent,
	};
}

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'package.json'),
		JSON.stringify({ name: 'issue-2525-recovery-test' }),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 2525 recovery',
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
							description: 'Recover legacy gate evidence',
							depends: [],
							files_touched: ['src/example.ts'],
						},
					],
				},
			],
		}),
	);
}

function evidencePath(directory: string): string {
	return path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
}

function writeEvidence(directory: string, evidence: TaskEvidence): string {
	const bytes = JSON.stringify(evidence, null, 2);
	fs.writeFileSync(evidencePath(directory), bytes);
	return createHash('sha256').update(bytes).digest('hex');
}

function context(directory: string): ToolContext {
	return {
		directory,
		agent: 'architect',
		sessionID: 'issue-2525-recovery',
	} as ToolContext;
}

async function callRepair(
	directory: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return JSON.parse(
		await TOOL_MANIFEST.repair_gate_evidence().execute(
			args,
			context(directory),
		),
	);
}

async function settleAcceptedCoderMutation(
	directory: string,
	expectedGeneration: number,
	transitionId: string,
) {
	await beginCoderSettlement({
		directory,
		taskId: TASK_ID,
		transitionId,
		actor: 'architect',
		expectedGeneration,
		context: {
			declaredFiles: ['src/example.ts'],
			baseline: captureWorkspaceSnapshot(directory),
			workflowGeneration: expectedGeneration,
		},
	});
	return settleCoderDispatch({
		directory,
		taskId: TASK_ID,
		transitionId,
		accepted: true,
		testEngineerExempt: false,
	});
}

describe('repair_gate_evidence legacy reconstruction recovery', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('issue-2525-recovery-'));
		writePlan(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('recovers the authoritative poisoned-receipt wedge and emits only clean later receipts', async () => {
		const sentinelReset: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL],
			gates: {},
			requirements_state: 'unknown',
			workflow: workflow(1, 'idle'),
			repair_provenance: {
				source_sha256: 'a'.repeat(64),
				source_generation: 0,
				requirements_receipt_hash: null,
			},
		};
		const wedge: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'reviewer',
				'test_engineer',
			],
			gates: {
				pre_check: proof('pre_check'),
				reviewer: proof('reviewer'),
				test_engineer: proof('test_engineer'),
			},
			workflow: workflow(2, 'tests_run'),
		};
		await appendTaskGateRequirementsReceiptIfNeeded(
			directory,
			TASK_ID,
			sentinelReset,
			wedge,
			{
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 1,
				transitionId: 'issue-2525-poisoned-receipt',
			},
		);
		const sourceSha = writeEvidence(directory, wedge);
		const blocked = JSON.parse(
			await TOOL_MANIFEST.update_task_status().execute(
				{ task_id: TASK_ID, status: 'completed' },
				context(directory),
			),
		);
		expect(blocked.success).toBe(false);
		expect(JSON.stringify(blocked)).toContain(
			'legacy receipt-less gate-repair marker',
		);
		expect(JSON.stringify(blocked)).toContain('repair_gate_evidence');

		const repaired = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'recover authoritative legacy marker wedge',
			expected_sha256: sourceSha,
			expected_generation: 2,
		});
		expect(repaired.success).toBe(true);
		expect(repaired.repaired).toBe(true);
		expect(repaired.requirements_state).toBe('unknown');
		expect(repaired.required_gates).toEqual(['reviewer', 'test_engineer']);
		const recoveredBytes = fs.readFileSync(evidencePath(directory), 'utf-8');
		const recovered = await readTaskEvidence(directory, TASK_ID);
		expect(recovered?.workflow?.state).toBe('idle');
		expect(recovered?.gates).toEqual({});
		expect(recovered?.required_gates).not.toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);

		const repeated = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'repeat authoritative legacy marker recovery',
			expected_sha256: sourceSha,
			expected_generation: 2,
		});
		expect(repeated.success).toBe(true);
		expect(repeated.repaired).toBe(false);
		expect(fs.readFileSync(evidencePath(directory), 'utf-8')).toBe(
			recoveredBytes,
		);

		const prematureCompletion = JSON.parse(
			await TOOL_MANIFEST.update_task_status().execute(
				{ task_id: TASK_ID, status: 'completed' },
				context(directory),
			),
		);
		expect(prematureCompletion.success).toBe(false);
		expect(JSON.stringify(prematureCompletion)).toContain('idle');

		await settleAcceptedCoderMutation(
			directory,
			3,
			'coder:issue-2525-clean-mutation',
		);
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: 4,
			transitionId: 'issue-2525-clean-stage-a',
		});
		await recordGateEvidence(
			directory,
			TASK_ID,
			'reviewer',
			'issue-2525-reviewer',
			false,
			{ expectedGeneration: 4, transitionId: 'issue-2525-clean-reviewer' },
		);
		await recordGateEvidence(
			directory,
			TASK_ID,
			'test_engineer',
			'issue-2525-test-engineer',
			false,
			{ expectedGeneration: 4, transitionId: 'issue-2525-clean-tests' },
		);

		const cleanEvidence = await readTaskEvidence(directory, TASK_ID);
		expect(cleanEvidence?.required_gates).toEqual([
			'reviewer',
			'test_engineer',
		]);
		const receipts = await readTaskGateRequirementsReceipts(directory, TASK_ID);
		expect(
			receipts.some((receipt) =>
				receipt.requiredGates.includes(
					TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				),
			),
		).toBe(true);
		expect(receipts.at(-1)?.requiredGates).toEqual([
			'reviewer',
			'test_engineer',
		]);

		const completion = JSON.parse(
			await TOOL_MANIFEST.update_task_status().execute(
				{ task_id: TASK_ID, status: 'completed' },
				context(directory),
			),
		);
		expect(completion.success).toBe(true);
	});

	test('recovers sentinel-only state, then fails closed on repeat until coder settlement', async () => {
		const sentinelReset: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL],
			gates: {},
			requirements_state: 'unknown',
			workflow: workflow(1, 'idle'),
			repair_provenance: {
				source_sha256: 'a'.repeat(64),
				source_generation: 0,
				requirements_receipt_hash: null,
			},
		};
		const sourceSha = writeEvidence(directory, sentinelReset);

		const mismatch = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'reject stale recovery identity',
			expected_sha256: '0'.repeat(64),
			expected_generation: 1,
		});
		expect(mismatch.success).toBe(false);
		expect(mismatch.message).toBe('TASK_GATE_EVIDENCE_CAS_MISMATCH');
		expect(fs.readFileSync(evidencePath(directory), 'utf-8')).toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);

		const repaired = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'recover sentinel-only legacy state',
			expected_sha256: sourceSha,
			expected_generation: 1,
		});
		expect(repaired.success).toBe(true);
		expect(repaired.required_gates).toEqual([]);
		expect(repaired.requirements_state).toBe('unknown');
		expect(repaired.repaired_generation).toBe(2);
		const repairedBytes = fs.readFileSync(evidencePath(directory), 'utf8');

		const repeated = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'repeat sentinel-only recovery',
		});
		expect(repeated.success).toBe(false);
		expect(repeated.message).toBe('TASK_GATE_REQUIREMENTS_RECEIPT_MISSING');
		expect(fs.readFileSync(evidencePath(directory), 'utf8')).toBe(
			repairedBytes,
		);

		await settleAcceptedCoderMutation(
			directory,
			2,
			'coder:issue-2525-sentinel-recovery',
		);
		const rederived = await readTaskEvidence(directory, TASK_ID);
		expect(rederived?.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(rederived?.workflow?.state).toBe('coder_delegated');
		expect(rederived?.required_gates).not.toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);
	});

	test('preserves non-default gates from a tainted receipt without granting known authority', async () => {
		const before: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'designer',
			],
			gates: {},
			requirements_state: 'unknown',
			workflow: workflow(1, 'idle'),
		};
		const tainted: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'designer',
				'reviewer',
				'test_engineer',
			],
			gates: {},
			workflow: workflow(2, 'coder_delegated'),
		};
		await appendTaskGateRequirementsReceiptIfNeeded(
			directory,
			TASK_ID,
			before,
			tainted,
			{
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 1,
				transitionId: 'issue-2525-designer-poisoned-receipt',
			},
		);
		fs.writeFileSync(evidencePath(directory), '{broken evidence');

		const repaired = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'recover from tainted non-default receipt',
		});
		expect(repaired.success).toBe(true);
		expect(repaired.requirements_state).toBe('unknown');
		expect(repaired.required_gates).toEqual([
			'designer',
			'reviewer',
			'test_engineer',
		]);
		expect(repaired.required_gates).not.toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);

		const repeated = await callRepair(directory, {
			task_id: TASK_ID,
			reason: 'repeat tainted non-default receipt recovery',
		});
		expect(repeated.success).toBe(true);
		expect(repeated.repaired).toBe(false);
	});

	test('retires only the legacy marker at accepted mutation and writes a clean receipt', async () => {
		writeEvidence(directory, {
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'designer',
			],
			gates: {},
			requirements_state: 'unknown',
			workflow: workflow(1, 'idle'),
		});

		const settlement = await settleAcceptedCoderMutation(
			directory,
			1,
			'coder:issue-2525-direct-retirement',
		);
		expect(settlement.alreadyApplied).toBe(false);
		const repeatedSettlement = await settleCoderDispatch({
			directory,
			taskId: TASK_ID,
			transitionId: 'coder:issue-2525-direct-retirement',
			accepted: true,
			testEngineerExempt: false,
		});
		expect(repeatedSettlement.alreadyApplied).toBe(true);

		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.required_gates).toEqual([
			'designer',
			'reviewer',
			'test_engineer',
		]);
		const receipts = await readTaskGateRequirementsReceipts(directory, TASK_ID);
		expect(receipts).toHaveLength(2);
		expect(receipts[0]?.requiredGates).toContain(
			TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
		);
		expect(receipts.at(-1)?.requiredGates).toEqual([
			'designer',
			'reviewer',
			'test_engineer',
		]);
	});
});
