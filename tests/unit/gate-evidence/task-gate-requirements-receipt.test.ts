import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readTaskGateRequirementsReceipts,
	taskGateRequirementsReceiptPath,
} from '../../../src/evidence/task-gate-requirements.js';
import { transitionTaskWorkflowEvidence } from '../../../src/gate-evidence.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

describe('task gate requirements receipts', () => {
	test('appends a new receipt when the workflow generation changes even if the required gates do not', async () => {
		const { dir, cleanup } = createSafeTestDir('task-gate-requirements-');
		try {
			await transitionTaskWorkflowEvidence(dir, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				context: { testEngineerExempt: true },
				expectedGeneration: 0,
				transitionId: 'coder-gen-1',
			});

			await transitionTaskWorkflowEvidence(dir, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				context: { testEngineerExempt: true },
				expectedGeneration: 1,
				transitionId: 'coder-gen-2',
			});

			const receiptPath = taskGateRequirementsReceiptPath(dir, '1.1');
			expect(fs.existsSync(receiptPath)).toBe(true);

			const receipts = await readTaskGateRequirementsReceipts(dir, '1.1');
			expect(receipts).toHaveLength(2);
			expect(receipts.map((receipt) => receipt.generation)).toEqual([1, 2]);
			expect(receipts.map((receipt) => receipt.requiredGates)).toEqual([
				['reviewer'],
				['reviewer'],
			]);
			expect(receipts.map((receipt) => receipt.sourceTransitionId)).toEqual([
				'coder-gen-1',
				'coder-gen-2',
			]);
		} finally {
			cleanup();
		}
	});

	test('rejects a redirected requirements directory without writing outside the project', async () => {
		const project = createSafeTestDir('task-gate-requirements-contained-');
		const escaped = createSafeTestDir('task-gate-requirements-escaped-');
		try {
			fs.mkdirSync(path.join(project.dir, '.swarm', 'evidence'), {
				recursive: true,
			});
			fs.symlinkSync(
				escaped.dir,
				path.join(project.dir, '.swarm', 'evidence', 'task-gate-requirements'),
				'junction',
			);

			await expect(
				transitionTaskWorkflowEvidence(project.dir, '1.1', {
					type: 'accepted_mutation',
					agentType: 'coder',
					context: { testEngineerExempt: true },
					expectedGeneration: 0,
					transitionId: 'redirected-receipt',
				}),
			).rejects.toThrow('TASK_GATE_REQUIREMENTS_UNREADABLE');
			expect(fs.readdirSync(escaped.dir)).toEqual([]);
		} finally {
			project.cleanup();
			escaped.cleanup();
		}
	});
});
