import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin/tool';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence.js';
import { resetSwarmState } from '../../../src/state.js';
import { executeRepairGateEvidence } from '../../../src/tools/repair-gate-evidence.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const TASK_ID = '1.1';
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function writePlan(directory: string): void {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(directory, 'package.json'),
		'{"name":"repair-test"}',
	);
	fs.writeFileSync(
		path.join(directory, '.swarm', 'plan.json'),
		JSON.stringify({
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
		}),
	);
}

function evidencePath(directory: string): string {
	return path.join(directory, '.swarm', 'evidence', `${TASK_ID}.json`);
}

describe('repair_gate_evidence safety', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(async () => {
		resetSwarmState();
		({ dir: directory, cleanup } = createSafeTestDir('repair-gate-evidence-'));
		writePlan(directory);
		await transitionTaskWorkflowEvidence(directory, TASK_ID, {
			type: 'accepted_mutation',
			agentType: 'coder',
			expectedGeneration: 0,
			transitionId: 'coder-gen-1',
		});
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	test('rejects non-substantive repair reasons during execution', async () => {
		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'repair' },
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_REASON_REQUIRED',
		);
	});

	test('rejects a non-architect runtime caller before reading or writing evidence', async () => {
		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'coder must not repair evidence' },
			directory,
			{ agent: 'mega_coder' } as ToolContext,
		);

		expect(result.success).toBe(false);
		expect(result.errors).toEqual(['TASK_GATE_EVIDENCE_ARCHITECT_ONLY']);
	});

	test('rejects repair of healthy authoritative evidence without resetting retry history', async () => {
		const before = fs.readFileSync(evidencePath(directory), 'utf8');
		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'do not rewrite valid evidence' },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.message).toBe('TASK_GATE_EVIDENCE_REPAIR_NOT_REQUIRED');
		expect(fs.readFileSync(evidencePath(directory), 'utf8')).toBe(before);
	});

	test('does not rewrite corrupt evidence while a terminal WAL owns the task', async () => {
		const corrupt = '{"taskId":"1.1","broken":';
		fs.writeFileSync(evidencePath(directory), corrupt);
		const terminalDirectory = path.join(directory, '.swarm', 'task-terminals');
		fs.mkdirSync(terminalDirectory, { recursive: true });
		fs.writeFileSync(
			path.join(terminalDirectory, `${TASK_ID}.json`),
			JSON.stringify({
				version: 1,
				state: 'PREPARED',
				taskId: TASK_ID,
				transitionId: 'terminal-owner',
				actor: 'architect',
				oldPlanStatus: 'in_progress',
				newPlanStatus: 'completed',
				oldWorkflowState: 'tests_run',
				newWorkflowState: 'complete',
				generation: 1,
				qaExempt: false,
				recordedAt: '2026-08-22T12:00:00.000Z',
			}),
		);

		const result = await executeRepairGateEvidence(
			{ task_id: TASK_ID, reason: 'respect the terminal WAL fence' },
			directory,
		);

		expect(result.success).toBe(false);
		expect(result.errors?.join(' ')).toContain('TASK_TERMINAL_PREPARED');
		expect(fs.readFileSync(evidencePath(directory), 'utf8')).toBe(corrupt);
	});

	test('fails closed when the evidence directory is redirected by a symlink or junction', async () => {
		const evidenceDirectory = path.join(directory, '.swarm', 'evidence');
		const redirected = path.join(directory, 'redirected-evidence');
		fs.rmSync(evidenceDirectory, { recursive: true, force: true });
		fs.mkdirSync(redirected, { recursive: true });
		try {
			fs.symlinkSync(redirected, evidenceDirectory, LINK_TYPE);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'EPERM' || code === 'EACCES') return;
			throw error;
		}

		const result = await executeRepairGateEvidence(
			{
				task_id: TASK_ID,
				reason: 'repair through redirected evidence must fail closed',
			},
			directory,
		);

		expect(result.success).toBe(false);
		expect([result.message, ...(result.errors ?? [])].join(' ')).toContain(
			'TASK_GATE_EVIDENCE_PATH_UNSAFE',
		);
	});
});
