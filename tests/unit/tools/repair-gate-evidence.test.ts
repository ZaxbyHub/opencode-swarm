import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	repairTaskGateEvidence,
	taskGateEvidenceQuarantinePath,
} from '../../../src/evidence/task-gate-repair.js';
import {
	readTaskEvidence,
	recordGateEvidence,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence.js';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state.js';
import { executeRepairGateEvidence } from '../../../src/tools/repair-gate-evidence.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'package.json'),
		JSON.stringify({ name: 'repair-gate-evidence-test' }, null, 2),
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify(
			{
				schema_version: '1.0.0',
				title: 'Repair gate evidence',
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
								description: 'Repairable task',
								depends: [],
								files_touched: ['src/example.ts'],
							},
						],
					},
				],
			},
			null,
			2,
		),
	);
}

async function seedCoderReceipt(directory: string): Promise<void> {
	await transitionTaskWorkflowEvidence(directory, TASK_ID, {
		type: 'accepted_mutation',
		agentType: 'coder',
		expectedGeneration: 0,
		transitionId: 'coder-gen-1',
	});
}

function evidencePath(directory: string): string {
	return path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
}

function sha256(bytes: Buffer | string): string {
	return createHash('sha256').update(bytes).digest('hex');
}

describe('repair_gate_evidence', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('repair-gate-evidence-'));
		writePlan(directory);
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('rebuilds corrupt evidence from the latest durable requirements receipt and quarantines the original bytes', async () => {
		await seedCoderReceipt(directory);
		const corruptBytes = Buffer.from('{"taskId":"1.1","broken":');
		fs.writeFileSync(evidencePath(directory), corruptBytes);

		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'repair corrupt gate evidence' },
			directory,
		);

		expect(result.success).toBe(true);
		expect(result.repaired).toBe(true);
		expect(result.requirements_state).toBe('known');
		expect(result.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(result.quarantine_path).toBeTruthy();
		expect(result.repaired_generation).toBe(2);
		expect(result.next_actions).toEqual([
			`Delegate coder on task ${TASK_ID} to produce a fresh accepted_mutation for the repaired evidence generation 2.`,
			`Rerun Stage A for task ${TASK_ID} until pre_check passes for the new generation.`,
			`Rerun Stage B gates [reviewer, test_engineer] for task ${TASK_ID} before attempting completion again.`,
		]);

		const repaired = JSON.parse(
			fs.readFileSync(evidencePath(directory), 'utf-8'),
		) as {
			required_gates: string[];
			gates: Record<string, unknown>;
			workflow: { state: string; generation: number };
			requirements_state?: string;
		};
		expect(repaired.required_gates).toEqual(['reviewer', 'test_engineer']);
		expect(repaired.gates).toEqual({});
		expect(repaired.workflow.state).toBe('idle');
		expect(repaired.workflow.generation).toBe(2);
		expect(repaired.requirements_state).toBe('known');

		const quarantinePath = taskGateEvidenceQuarantinePath(
			directory,
			TASK_ID,
			result.quarantine_digest!,
		);
		expect(fs.existsSync(quarantinePath)).toBe(true);
		const quarantine = JSON.parse(fs.readFileSync(quarantinePath, 'utf-8')) as {
			taskId: string;
			reason: string;
			original: { sha256: string; sizeBytes: number };
			caller: { sessionId: string | null };
			parseError: { message: string } | null;
			content: { encoding: string; bytes: string };
		};
		expect(quarantine.taskId).toBe(TASK_ID);
		expect(quarantine.reason).toBe('repair corrupt gate evidence');
		expect(quarantine.original.sha256).toBe(sha256(corruptBytes));
		expect(quarantine.original.sizeBytes).toBe(corruptBytes.byteLength);
		expect(quarantine.caller.sessionId).toBeNull();
		expect(quarantine.parseError?.message).toContain('JSON');
		expect(quarantine.content.encoding).toBe('base64');
		expect(Buffer.from(quarantine.content.bytes, 'base64')).toEqual(
			corruptBytes,
		);
	});

	test('rejects a stale SHA CAS without mutating the corrupt evidence', async () => {
		await seedCoderReceipt(directory);
		const corruptText = '{"taskId":"1.1","broken":';
		fs.writeFileSync(evidencePath(directory), corruptText);

		const result = await executeRepairGateEvidence(
			{
				task_id: TASK_ID,
				reason: 'repair corrupt gate evidence',
				expected_sha256: '0'.repeat(64),
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_CAS_MISMATCH',
		);
		expect(fs.readFileSync(evidencePath(directory), 'utf-8')).toBe(corruptText);
	});

	test('repeating the identical SHA and generation CAS repair is idempotent', async () => {
		await seedCoderReceipt(directory);
		const corruptBytes = Buffer.from('{"taskId":"1.1","broken":');
		fs.writeFileSync(evidencePath(directory), corruptBytes);
		const args = {
			task_id: TASK_ID,
			reason: 'repair the same corrupt generation exactly once',
			expected_sha256: sha256(corruptBytes),
			expected_generation: 1,
		};

		const first = await executeRepairGateEvidence(args, directory);
		const repairedBytes = fs.readFileSync(evidencePath(directory));
		const second = await executeRepairGateEvidence(args, directory);

		expect(first.success).toBe(true);
		expect(first.repaired).toBe(true);
		expect(second.success).toBe(true);
		expect(second.repaired).toBe(false);
		expect(second.repaired_generation).toBe(first.repaired_generation);
		expect(fs.readFileSync(evidencePath(directory))).toEqual(repairedBytes);
	});

	test('refuses to rewrite an authoritative generation ahead of its requirements receipt', async () => {
		await seedCoderReceipt(directory);
		const current = JSON.parse(
			fs.readFileSync(evidencePath(directory), 'utf8'),
		) as { workflow: { generation: number } };
		current.workflow.generation = 5;
		fs.writeFileSync(evidencePath(directory), JSON.stringify(current, null, 2));

		const before = fs.readFileSync(evidencePath(directory));
		const result = await executeRepairGateEvidence(
			{
				task_id: TASK_ID,
				reason: 'repair evidence ahead of receipt generation',
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.message).toBe('TASK_GATE_EVIDENCE_REPAIR_NOT_REQUIRED');
		expect(fs.readFileSync(evidencePath(directory))).toEqual(before);
	});

	test('remains incomplete after only reviewer evidence reruns in the fresh generation', async () => {
		await seedCoderReceipt(directory);
		fs.writeFileSync(evidencePath(directory), '{"taskId":"1.1","broken":');
		const repaired = await executeRepairGateEvidence(
			{
				task_id: TASK_ID,
				reason: 'repair before rerunning every stage b gate',
			},
			directory,
		);
		expect(repaired.repaired_generation).toBe(2);

		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 2,
			transitionId: 'repair-coder-generation-3',
		});
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'stage_a_passed',
			expectedGeneration: 3,
			transitionId: 'repair-stage-a-generation-3',
		});
		await recordGateEvidence(
			directory,
			TASK_ID,
			'reviewer',
			'repair-reviewer-session',
			false,
			{ expectedGeneration: 3, transitionId: 'repair-reviewer-generation-3' },
		);

		const evidence = await readTaskEvidence(directory, TASK_ID);
		expect(evidence?.gates.reviewer).toBeDefined();
		expect(evidence?.gates.test_engineer).toBeUndefined();
		expect(
			evidence?.required_gates.filter(
				(gate) => evidence.gates[gate] === undefined,
			),
		).toEqual(['test_engineer']);
		expect(evidence?.workflow?.state).not.toBe('complete');
	});

	test('fails closed when evidence is absent and no authoritative requirements receipt exists', async () => {
		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'attempt absent repair' },
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_ABSENT',
		);
	});

	test('refuses legacy evidence without an authoritative receipt atomically', async () => {
		fs.mkdirSync(path.dirname(evidencePath(directory)), { recursive: true });
		const originalBytes = JSON.stringify(
			{
				taskId: TASK_ID,
				required_gates: ['reviewer', 'test_engineer'],
				gates: {
					reviewer: {
						sessionId: 'legacy-reviewer',
						timestamp: '2026-01-01T00:00:00.000Z',
						agent: 'reviewer',
					},
				},
			},
			null,
			2,
		);
		fs.writeFileSync(evidencePath(directory), originalBytes);

		const session = ensureAgentSession(
			'repair-gate-evidence-session',
			'architect',
		);
		session.lastCoderDelegationTaskId = TASK_ID;
		session.currentTaskId = TASK_ID;
		session.taskWorkflowStates.set(TASK_ID, 'tests_run');
		session.stageBCompletion?.set(
			TASK_ID,
			new Set(['reviewer', 'test_engineer']),
		);
		session.taskCouncilApproved?.set(TASK_ID, {
			verdict: 'APPROVE',
			roundNumber: 1,
			quorumSize: 3,
		});
		session.taskCouncilWorkflowGeneration?.set(TASK_ID, 3);

		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'repair legacy evidence' },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.message).toContain('TASK_GATE_REQUIREMENTS_RECEIPT_MISSING');
		expect(fs.readFileSync(evidencePath(directory), 'utf-8')).toBe(
			originalBytes,
		);
		expect(
			fs.existsSync(
				path.join(directory, '.swarm', 'evidence', 'task-gate-quarantine'),
			),
		).toBe(false);

		const updatedSession = swarmState.agentSessions.get(
			'repair-gate-evidence-session',
		)!;
		expect(updatedSession.currentTaskId).toBe(TASK_ID);
		expect(updatedSession.lastCoderDelegationTaskId).toBe(TASK_ID);
		expect(updatedSession.taskWorkflowStates.get(TASK_ID)).toBe('tests_run');
		expect(updatedSession.stageBCompletion?.get(TASK_ID)).toEqual(
			new Set(['reviewer', 'test_engineer']),
		);
		expect(updatedSession.taskCouncilApproved?.has(TASK_ID)).toBe(true);
		expect(updatedSession.taskCouncilWorkflowGeneration?.get(TASK_ID)).toBe(3);
	});

	test('fails closed without overwrite when the original evidence file is oversized', async () => {
		await seedCoderReceipt(directory);
		const oversized = Buffer.alloc(256 * 1024 + 1, 'x');
		fs.writeFileSync(evidencePath(directory), oversized);

		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'repair oversized gate evidence safely' },
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_OVERSIZED',
		);
		expect(fs.readFileSync(evidencePath(directory))).toEqual(oversized);
		expect(result.quarantine_path).toBeUndefined();
	});

	test('fails closed without overwrite when the original evidence path is unreadable', async () => {
		await seedCoderReceipt(directory);
		fs.rmSync(evidencePath(directory), { force: true });
		fs.mkdirSync(evidencePath(directory), { recursive: true });

		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'repair unreadable evidence path safely' },
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_UNREADABLE',
		);
		expect(fs.lstatSync(evidencePath(directory)).isDirectory()).toBe(true);
	});

	test('is idempotent under duplicate concurrent repair calls', async () => {
		await seedCoderReceipt(directory);
		const corruptBytes = Buffer.from('{"taskId":"1.1","broken":');
		fs.writeFileSync(evidencePath(directory), corruptBytes);

		const [first, second] = await Promise.all([
			executeRepairGateEvidence(
				{
					task_id: TASK_ID,
					reason: 'repair duplicate corrupt evidence safely',
				},
				directory,
			),
			executeRepairGateEvidence(
				{
					task_id: TASK_ID,
					reason: 'repair duplicate corrupt evidence safely',
				},
				directory,
			),
		]);

		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		expect([first.repaired, second.repaired].sort()).toEqual([false, true]);
		expect(fs.readFileSync(evidencePath(directory), 'utf8')).toContain(
			'"generation": 2',
		);
		const quarantinePath = taskGateEvidenceQuarantinePath(
			directory,
			TASK_ID,
			sha256(corruptBytes),
		);
		expect(fs.existsSync(quarantinePath)).toBe(true);
		expect(
			fs
				.readdirSync(path.dirname(quarantinePath))
				.filter((entry) => entry.includes(sha256(corruptBytes))),
		).toEqual([path.basename(quarantinePath)]);
	});

	test('fails closed when called on a subdirectory instead of the canonical project root', async () => {
		const child = path.join(directory, 'nested');
		fs.mkdirSync(child, { recursive: true });

		const result = await executeRepairGateEvidence(
			{
				task_id: TASK_ID,
				reason: 'repair from wrong root must fail closed',
			},
			child,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'project root',
		);
	});

	test('fails closed when the supplied project root is a symlink or junction', async () => {
		const linkedRoot = path.join(
			path.dirname(directory),
			'repair-gate-root-link',
		);
		try {
			fs.symlinkSync(directory, linkedRoot, LINK_TYPE);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}

		try {
			const result = await executeRepairGateEvidence(
				{
					task_id: TASK_ID,
					reason: 'repair through symlinked root must fail closed',
				},
				linkedRoot,
			);

			expect(result.success).toBe(false);
			expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
				'TASK_GATE_EVIDENCE_ROOT_UNSAFE',
			);
		} finally {
			fs.rmSync(linkedRoot, { recursive: true, force: true });
		}
	});
});
