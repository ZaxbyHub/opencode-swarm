import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	readTaskEvidenceRaw,
	transitionTaskWorkflowEvidence,
} from '../../../src/gate-evidence';
import { repairTaskWorkflowUnderPlanLock } from '../../../src/workflow/task-repair';

describe('issue #2098 truthful close repair', () => {
	let directory: string;

	beforeEach(async () => {
		directory = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'task-repair-closed-2098-')),
		);
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		await transitionTaskWorkflowEvidence(directory, '1.1', {
			type: 'task_closed',
			expectedGeneration: 0,
			transitionId: 'close-before-repair',
		});
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true, force: true });
	});

	test('audited exact-CAS repair reopens a closed task to idle', async () => {
		const result = await repairTaskWorkflowUnderPlanLock({
			directory,
			taskId: '1.1',
			actor: 'architect',
			reason: 'Resume unfinished work after session close',
			transitionId: 'repair-closed:1.1:0',
			expectedState: 'closed',
			expectedGeneration: 0,
			currentPlanStatus: 'closed',
			currentPlan: { status: 'closed' },
			updatePlan: async () => ({ status: 'in_progress' }),
		});

		expect(result.plan).toEqual({ status: 'in_progress' });
		expect(result.generation).toBe(1);
		expect(readTaskEvidenceRaw(directory, '1.1')?.workflow).toMatchObject({
			state: 'idle',
			generation: 1,
			lastOutcome: 'repair_idle',
		});
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(directory, '.swarm', 'task-repairs', '1.1.json'),
					'utf8',
				),
			).state,
		).toBe('COMMITTED');
		expect(
			fs.readFileSync(path.join(directory, '.swarm', 'events.jsonl'), 'utf8'),
		).toContain('"taskId":"1.1"');
	});
});
