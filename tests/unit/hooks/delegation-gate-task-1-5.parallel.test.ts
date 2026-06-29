/**
 * Parallel execution profile [NEXT] guidance tests (delegation-gate-task-1-5.test.ts — Part 2 of 3)
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { createDelegationGateHook } from '../../../src/hooks/delegation-gate';
import {
	advanceTaskState,
	ensureAgentSession,
	resetSwarmState,
} from '../../../src/state';
import { makeConfig, makeMessages } from './_delegation-gate-helpers';

function makeTempProject(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	const real = fs.realpathSync(dir);
	fs.mkdirSync(path.join(real, '.swarm'), { recursive: true });
	return real;
}

function writePlanJson(
	dir: string,
	options: {
		executionProfile?: Record<string, unknown>;
		tasks?: Array<{
			id: string;
			status?: string;
			depends?: string[];
			phase?: number;
		}>;
		currentPhase?: number;
	},
): void {
	const phase = options.currentPhase ?? 1;
	const tasks = options.tasks ?? [
		{ id: '1.1', status: 'pending' },
		{ id: '1.2', status: 'pending' },
	];
	const plan = {
		schema_version: '1.0.0',
		title: 'Parallel Test Plan',
		swarm: 'test-swarm',
		current_phase: phase,
		phases: [
			{
				id: phase,
				name: `Phase ${phase}`,
				status: 'in_progress',
				tasks: tasks.map((task) => ({
					id: task.id,
					phase: task.phase ?? phase,
					status: task.status ?? 'pending',
					size: 'small',
					description: `Task ${task.id}`,
					depends: task.depends ?? [],
					files_touched: [],
				})),
			},
		],
		...(options.executionProfile
			? { execution_profile: options.executionProfile }
			: {}),
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
	);
}

describe('delegation-gate task 1.5: parallel execution profile [NEXT] guidance', () => {
	let tempDir: string;

	beforeEach(() => {
		resetSwarmState();
		tempDir = makeTempProject('delegation-gate-parallel-next-');
	});

	afterEach(() => {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
		resetSwarmState();
	});

	it('should list eligible pending tasks up to available parallel slots', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				locked: true,
			},
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
				{ id: '1.3', status: 'pending' },
				{ id: '1.4', status: 'pending' },
			],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('PARALLEL EXECUTION PROFILE');
		expect(systemText).toContain('max_concurrent_tasks=4');
		expect(systemText).toContain('dispatch up to 4');
		expect(systemText).toContain('Eligible now: 1.1, 1.2, 1.3, 1.4');
	});

	it('should keep serial guidance when profile is disabled or serial', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: false,
				max_concurrent_tasks: 4,
				locked: true,
			},
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('run gates sequentially');
		expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
	});

	it('should count in-progress tasks as occupied and exclude blocked/dependent tasks', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 3,
				locked: true,
			},
			tasks: [
				{ id: '1.1', status: 'in_progress' },
				{ id: '1.2', status: 'pending', depends: ['1.1'] },
				{ id: '1.3', status: 'pending' },
				{ id: '1.4', status: 'blocked' },
			],
		});

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('dispatch up to 2');
		expect(systemText).toContain('Eligible now: 1.3');
		expect(systemText).not.toContain('Eligible now: 1.2');
		expect(systemText).not.toContain('Eligible now: 1.4');
	});

	it('should count active in-memory workflow states as occupied slots', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				locked: true,
			},
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
				{ id: '1.3', status: 'pending' },
				{ id: '1.4', status: 'pending' },
			],
		});
		const session = ensureAgentSession('test-session');
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.2', 'coder_delegated');
		advanceTaskState(session, '1.2', 'pre_check_passed');
		advanceTaskState(session, '1.3', 'coder_delegated');
		advanceTaskState(session, '1.3', 'pre_check_passed');
		advanceTaskState(session, '1.3', 'reviewer_run');

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('3 slot(s) occupied');
		expect(systemText).toContain('dispatch up to 1');
		expect(systemText).toContain('Eligible now: 1.4');
		expect(systemText).not.toContain('Eligible now: 1.1');
	});

	it('should count reviewer_run bridge state as an occupied slot', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				locked: true,
			},
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
				{ id: '1.3', status: 'pending' },
			],
		});
		const session = ensureAgentSession('test-session');
		advanceTaskState(session, '1.1', 'coder_delegated');
		advanceTaskState(session, '1.1', 'pre_check_passed');
		advanceTaskState(session, '1.1', 'reviewer_run');

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('1 slot(s) occupied');
		expect(systemText).toContain('dispatch up to 1');
		expect(systemText).toContain('Eligible now: 1.2');
		expect(systemText).not.toContain('Eligible now: 1.1');
		expect(systemText).not.toContain('Eligible now: 1.3');
	});

	it('should count active work across phases against the plan-level slot budget', async () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'Cross Phase Occupancy Test Plan',
			swarm: 'test-swarm',
			current_phase: 2,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				locked: true,
			},
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'in_progress',
							size: 'small',
							description: 'Active earlier-phase task',
							depends: [],
							files_touched: [],
						},
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Ready task one',
							depends: [],
							files_touched: [],
						},
						{
							id: '2.2',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Ready task two',
							depends: [],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('1 slot(s) occupied');
		expect(systemText).toContain('dispatch up to 1');
		expect(systemText).toContain('Eligible now: 2.1');
		expect(systemText).not.toContain('Eligible now: 2.2');
	});

	it('should treat completed dependencies from earlier phases as eligible inputs', async () => {
		const plan = {
			schema_version: '1.0.0',
			title: 'Cross Phase Parallel Test Plan',
			swarm: 'test-swarm',
			current_phase: 2,
			execution_profile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 2,
				locked: true,
			},
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'complete',
					tasks: [
						{
							id: '1.1',
							phase: 1,
							status: 'completed',
							size: 'small',
							description: 'Completed prerequisite',
							depends: [],
							files_touched: [],
						},
					],
				},
				{
					id: 2,
					name: 'Phase 2',
					status: 'in_progress',
					tasks: [
						{
							id: '2.1',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Ready task',
							depends: ['1.1'],
							files_touched: [],
						},
						{
							id: '2.2',
							phase: 2,
							status: 'pending',
							size: 'small',
							description: 'Blocked by unmet dependency',
							depends: ['2.9'],
							files_touched: [],
						},
					],
				},
			],
		};
		fs.writeFileSync(
			path.join(tempDir, '.swarm', 'plan.json'),
			JSON.stringify(plan, null, 2),
		);

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('Eligible now: 2.1');
		expect(systemText).not.toContain('Eligible now: 2.2');
	});

	it('should fail open to serial guidance when plan.json is missing', async () => {
		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('run gates sequentially');
		expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
	});

	it('should fail open to serial guidance when plan.json is malformed', async () => {
		fs.writeFileSync(path.join(tempDir, '.swarm', 'plan.json'), '{nope');

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('run gates sequentially');
		expect(systemText).not.toContain('PARALLEL EXECUTION PROFILE');
	});

	it('should suppress standard slot-filling guidance when Lean Turbo is active', async () => {
		writePlanJson(tempDir, {
			executionProfile: {
				parallelization_enabled: true,
				max_concurrent_tasks: 4,
				locked: true,
			},
			tasks: [
				{ id: '1.1', status: 'pending' },
				{ id: '1.2', status: 'pending' },
			],
		});
		const session = ensureAgentSession('test-session');
		session.turboMode = true;
		session.turboStrategy = 'lean';
		session.leanTurboActive = true;

		const hook = createDelegationGateHook(makeConfig(), tempDir);
		const messages = makeMessages('TASK: Continue work', 'architect');

		await hook.messagesTransform({}, messages);

		const systemText = messages.messages
			.filter((m) => m?.info?.role === 'system')
			.map((m) => m.parts[0].text)
			.join('\n');

		expect(systemText).toContain('Lean Turbo is active');
		expect(systemText).not.toContain('Eligible now:');
	});
});
