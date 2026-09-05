import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../../src/config/plan-schema';
import {
	observePhaseParticipationToolResult,
	PHASE_PARTICIPATION_FILE,
	readPhaseParticipation,
	reserveApprovedPhaseParticipation,
	resetPhaseParticipationForTests,
} from '../../../src/evidence/phase-participation';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function plan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Participation Retry Plan',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Implementation',
				status: 'in_progress',
				required_agents: ['docs'],
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Document retry behavior',
						depends: [],
						files_touched: ['docs/configuration.md'],
					},
				],
			},
		],
	};
}

describe('phase participation persistence retries', () => {
	let directory: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir: directory, cleanup } = createSafeTestDir(
			'phase-participation-retry-',
		));
		fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(directory, '.swarm', 'plan.json'),
			JSON.stringify(plan(), null, 2),
		);
		resetPhaseParticipationForTests();
	});

	afterEach(() => {
		resetPhaseParticipationForTests();
		cleanup();
	});

	test('replays the same successful result after a transient store failure', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});

		const evidencePath = path.join(
			directory,
			'.swarm',
			PHASE_PARTICIPATION_FILE,
		);
		fs.rmSync(evidencePath);
		fs.mkdirSync(evidencePath);
		const output = {
			output: 'Documentation updated and verified.',
			metadata: {
				status: 'completed',
				parentSessionId: 'parent',
				sessionId: 'child',
			},
		};

		await expect(
			observePhaseParticipationToolResult({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				output,
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_UNREADABLE');

		fs.rmSync(evidencePath, { recursive: true });
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output,
		});

		expect(
			(await readPhaseParticipation(directory, plan(), 1, 'docs')).found,
		).toBe(true);
	});

	test('replays the same running result after a transient store failure', async () => {
		await reserveApprovedPhaseParticipation({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			args: { subagent_type: 'docs' },
			policy: {},
		});

		const evidencePath = path.join(
			directory,
			'.swarm',
			PHASE_PARTICIPATION_FILE,
		);
		fs.rmSync(evidencePath);
		fs.mkdirSync(evidencePath);
		const output = {
			output:
				'<task id="child" state="running"><summary>running</summary></task>',
			metadata: { background: true, status: 'running', jobId: 'job-child' },
		};

		await expect(
			observePhaseParticipationToolResult({
				directory,
				tool: 'Task',
				parentSessionId: 'parent',
				callId: 'call',
				output,
			}),
		).rejects.toThrow('PHASE_PARTICIPATION_UNREADABLE');

		fs.rmSync(evidencePath, { recursive: true });
		await observePhaseParticipationToolResult({
			directory,
			tool: 'Task',
			parentSessionId: 'parent',
			callId: 'call',
			output,
		});

		const store = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as {
			pending: Array<{ childSessionId: string }>;
		};
		expect(store.pending).toEqual([
			expect.objectContaining({ childSessionId: 'child' }),
		]);
	});
});
