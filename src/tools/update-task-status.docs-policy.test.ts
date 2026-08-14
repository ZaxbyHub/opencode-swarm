import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { recordGateEvidence } from '../gate-evidence';
import { resetSwarmState } from '../state';
import { executeUpdateTaskStatus } from './update-task-status';

describe('update_task_status docs phase policy', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = mkdtempSync(path.join(os.tmpdir(), 'update-task-docs-policy-'));
		mkdirSync(path.join(tempDir, '.git'), { recursive: true });
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		resetSwarmState();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it('locked no-review phase completes without Stage B', async () => {
		writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Docs-only',
				swarm: 'test-swarm',
				current_phase: 1,
				execution_profile: { locked: true },
				phases: [
					{
						id: 1,
						name: 'Docs',
						status: 'in_progress',
						required_agents: ['docs'],
						tasks: [
							{
								id: '6.2',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'docs task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
		await recordGateEvidence(tempDir, '6.2', 'docs', 'sess-docs');

		const result = await executeUpdateTaskStatus({
			task_id: '6.2',
			status: 'completed',
			working_directory: tempDir,
		});
		expect(result.success).toBe(true);
	});
});
