import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { appendTaskGateRequirementsReceiptIfNeeded } from '../../../src/evidence/task-gate-requirements.js';
import {
	TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
	TASK_WORKFLOW_SCHEMA_MARKER,
	type TaskEvidence,
} from '../../../src/gate-evidence.js';
import { resetSwarmState } from '../../../src/state.js';
import { TOOL_MANIFEST } from '../../../src/tools/manifest.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm', 'evidence'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'package.json'),
		'{"name":"issue-2525"}',
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Issue 2525 receipt authority',
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
							description: 'Reject ambiguous receipt-less evidence',
							depends: [],
							files_touched: ['src/example.ts'],
						},
					],
				},
			],
		}),
	);
}

function repairReset(): NonNullable<TaskEvidence['workflow']> {
	return {
		schema: TASK_WORKFLOW_SCHEMA_MARKER,
		generation: 2,
		state: 'idle',
		retryCount: 0,
		retryHistory: [],
		retryEpoch: 0,
		lastOutcome: 'repair_idle',
		lastTransitionId: `repair_gate_evidence:${TASK_ID}:ambiguous`,
		updatedAt: '2026-01-01T00:00:00.000Z',
	};
}

describe('repair_gate_evidence receipt-less authority (issue #2525)', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('issue-2525-authority-'));
		writePlan(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	async function repair(
		evidence: TaskEvidence,
	): Promise<Record<string, unknown>> {
		const file = path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
		const original = JSON.stringify(evidence, null, 2);
		fs.writeFileSync(file, original);
		const result = JSON.parse(
			await TOOL_MANIFEST.repair_gate_evidence().execute(
				{ task_id: TASK_ID, reason: 'reject ambiguous receipt-less evidence' },
				{
					directory,
					agent: 'architect',
					sessionID: 'issue-2525-authority',
				} as ToolContext,
			),
		) as Record<string, unknown>;
		expect(result.message).toBe('TASK_GATE_REQUIREMENTS_RECEIPT_MISSING');
		expect(fs.readFileSync(file, 'utf8')).toBe(original);
		return result;
	}

	test('refuses valid-schema known evidence without receipt authority', async () => {
		await repair({
			taskId: TASK_ID,
			required_gates: ['reviewer'],
			gates: {},
			requirements_state: 'known',
			workflow: repairReset(),
		});
	});

	test('does not bless a marker-free repaired-looking file with unverified gates', async () => {
		await repair({
			taskId: TASK_ID,
			required_gates: ['designer'],
			gates: {},
			requirements_state: 'unknown',
			workflow: repairReset(),
			repair_provenance: {
				source_sha256: null,
				source_generation: 1,
				requirements_receipt_hash: null,
			},
		});
	});

	test('refuses a mixed marker artifact outside the historical reset shape', async () => {
		await repair({
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'designer',
			],
			gates: {},
			requirements_state: 'unknown',
			workflow: repairReset(),
			repair_provenance: {
				source_sha256: null,
				source_generation: null,
				requirements_receipt_hash: null,
			},
		});
	});

	test('does not demote clean evidence when only the latest receipt is tainted', async () => {
		const legacyReset: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL],
			gates: {},
			requirements_state: 'unknown',
			workflow: { ...repairReset(), generation: 1 },
		};
		const tainted: TaskEvidence = {
			taskId: TASK_ID,
			required_gates: [
				TASK_GATE_REQUIREMENTS_RECONSTRUCTION_SENTINEL,
				'designer',
			],
			gates: {},
			requirements_state: 'known',
			workflow: {
				...repairReset(),
				state: 'coder_delegated',
				lastOutcome: 'accepted_mutation',
			},
		};
		await appendTaskGateRequirementsReceiptIfNeeded(
			directory,
			TASK_ID,
			legacyReset,
			tainted,
			{
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 1,
				transitionId: 'issue-2525-tainted-only',
			},
		);
		const clean = {
			...tainted,
			required_gates: ['designer'],
		};
		const file = path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
		const original = JSON.stringify(clean, null, 2);
		fs.writeFileSync(file, original);
		const result = JSON.parse(
			await TOOL_MANIFEST.repair_gate_evidence().execute(
				{ task_id: TASK_ID, reason: 'preserve clean settled evidence' },
				{
					directory,
					agent: 'architect',
					sessionID: 'issue-2525-authority',
				} as ToolContext,
			),
		) as Record<string, unknown>;
		expect(JSON.stringify(result)).toContain(
			'TASK_GATE_REQUIREMENTS_RECEIPT_STALE',
		);
		expect(fs.readFileSync(file, 'utf8')).toBe(original);
	});
});
