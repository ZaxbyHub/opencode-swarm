import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleConcurrencyCommand } from '../../../src/commands/concurrency';
import { getAgentSession, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'concurrency-inherited-preset';

describe('handleConcurrencyCommand - inherited Object.prototype keys are not presets', () => {
	let projectDir: string;

	beforeAll(() => {
		projectDir = canonicalMkdtemp('concurrency-inherited-preset-');
		fs.mkdirSync(path.join(projectDir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(projectDir, '.swarm', 'plan.json'),
			JSON.stringify({
				schema_version: '1.0.0',
				title: 'Test Project',
				swarm: 'mega',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'pending',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'pending',
								size: 'small',
								description: 'task',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			}),
		);
	});

	afterAll(() => {
		fs.rmSync(projectDir, { recursive: true, force: true });
	});

	afterEach(() => {
		swarmState.agentSessions.delete(SESSION_ID);
	});

	test.each([
		'constructor',
		'CONSTRUCTOR',
		'__proto__',
	])('`set %s` is rejected and does not store a non-numeric override', async (value) => {
		swarmState.agentSessions.set(SESSION_ID, {} as never);

		const reply = await handleConcurrencyCommand(
			projectDir,
			['set', value],
			SESSION_ID,
		);

		expect(reply).toContain('Invalid concurrency value');
		expect(getAgentSession(SESSION_ID)?.maxConcurrencyOverride).toBe(undefined);
	});

	test('a real preset is still applied', async () => {
		swarmState.agentSessions.set(SESSION_ID, {} as never);

		const reply = await handleConcurrencyCommand(
			projectDir,
			['set', 'MEDIUM'],
			SESSION_ID,
		);

		expect(reply).toBe('Concurrency override set to 8 (medium)');
		expect(getAgentSession(SESSION_ID)?.maxConcurrencyOverride).toBe(8);
	});
});
