import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createCompactionCustomizerHook } from '../../../src/hooks/compaction-customizer';
import {
	buildRehydrationCache,
	ensureAgentSession,
	resetSwarmState,
} from '../../../src/state';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const defaultConfig: PluginConfig = {
	max_iterations: 5,
	qa_retry_limit: 3,
	inject_phase_reminders: true,
};

describe('post-compaction rehydration cache refresh', () => {
	let tempDir: string;
	let cleanup: () => void;

	beforeEach(() => {
		resetSwarmState();
		({ dir: tempDir, cleanup } = createSafeTestDir('swarm-rehydration-'));
		const swarmDir = join(tempDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		writeFileSync(join(swarmDir, 'plan.md'), '');
		writeFileSync(join(swarmDir, 'context.md'), '');
	});

	afterEach(() => {
		resetSwarmState();
		cleanup();
	});

	it('refreshes cached workflow state after compaction', async () => {
		const swarmDir = join(tempDir, '.swarm');
		const initialPlan = {
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'pending',
							size: 'small',
							description: 'Task one',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		writeFileSync(join(swarmDir, 'plan.json'), JSON.stringify(initialPlan));
		await buildRehydrationCache(tempDir);

		const sessionBefore = ensureAgentSession(
			'session-before',
			'architect',
			tempDir,
		);
		expect(sessionBefore.taskWorkflowStates?.get('1.1')).toBe('idle');

		resetSwarmState();
		writeFileSync(
			join(swarmDir, 'plan.json'),
			JSON.stringify({
				...initialPlan,
				phases: [
					{
						...initialPlan.phases[0],
						tasks: [
							{
								...initialPlan.phases[0].tasks[0],
								status: 'completed',
							},
						],
					},
				],
			}),
		);

		const hook = createCompactionCustomizerHook(defaultConfig, tempDir);
		const handler = hook['experimental.session.compacting'] as Function;
		await handler({ sessionID: 'test-session' }, { context: [] as string[] });

		const sessionAfter = ensureAgentSession(
			'session-after',
			'architect',
			tempDir,
		);
		expect(sessionAfter.taskWorkflowStates?.get('1.1')).toBe('complete');
	});
});
