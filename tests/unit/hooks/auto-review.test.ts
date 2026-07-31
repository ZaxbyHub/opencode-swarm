import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AutoReviewConfigSchema } from '../../../src/config/schema';
import {
	_internals,
	createAutoReviewHook,
} from '../../../src/hooks/auto-review';
import type { ReviewModelDispatcher } from '../../../src/review/contracts';
import { swarmState } from '../../../src/state';

let tmpDir: string;
const originalRunAutoReview = _internals.runAutoReview;
const originalNow = _internals.now;
const originalGeneratedAgentNames = [...swarmState.generatedAgentNames];
const dispatcher = {
	dispatch: async () => {
		throw new Error('not called directly');
	},
} as ReviewModelDispatcher;

function makeConfig(overrides: Record<string, unknown> = {}) {
	return AutoReviewConfigSchema.parse({ enabled: true, ...overrides });
}

function readEvents(): Array<Record<string, unknown>> {
	const target = path.join(tmpDir, '.swarm', 'events.jsonl');
	if (!fs.existsSync(target)) return [];
	return fs
		.readFileSync(target, 'utf8')
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'auto-review-hook-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	swarmState.generatedAgentNames = [
		'architect',
		'reviewer',
		'critic_finding_validator',
	];
});

afterEach(() => {
	_internals.runAutoReview = originalRunAutoReview;
	_internals.now = originalNow;
	swarmState.activeAgent.delete('s1');
	swarmState.generatedAgentNames = [...originalGeneratedAgentNames];
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createAutoReviewHook', () => {
	function recordingHook(config = makeConfig()) {
		const calls: Array<{ trigger: string; taskId?: string }> = [];
		_internals.runAutoReview = async (input) => {
			calls.push({ trigger: input.trigger, taskId: input.taskId });
			return undefined;
		};
		return {
			calls,
			hook: createAutoReviewHook({
				config,
				directory: tmpDir,
				dispatcher,
				injectAdvisory: () => {},
			}),
		};
	}

	test('disabled and phase-boundary-only configs are no-op hooks', async () => {
		for (const config of [
			makeConfig({ enabled: false }),
			makeConfig({ trigger: 'phase_boundary' }),
		]) {
			const { hook, calls } = recordingHook(config);
			await hook.toolAfter(
				{ tool: 'phase_complete', sessionID: 's1' },
				{ args: { phase: 1 } },
			);
			await hook.toolAfter(
				{ tool: 'update_task_status', sessionID: 's1' },
				{ args: { task_id: '1.1', status: 'completed' } },
			);
			expect(calls).toHaveLength(0);
		}
	});

	test('task_completion dispatches only for completed tasks', async () => {
		const { hook, calls } = recordingHook(
			makeConfig({ trigger: 'task_completion' }),
		);
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'in_progress' } },
		);
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);
		expect(calls).toEqual([{ trigger: 'task_completion', taskId: '1.1' }]);
	});

	test('two hook instances retain their own multi-swarm agent registry', async () => {
		const calls: Array<{
			directory: string;
			sessionID: string;
			dispatcher?: ReviewModelDispatcher;
			generatedAgentNames: string[];
		}> = [];
		_internals.runAutoReview = async (input) => {
			calls.push({
				directory: input.directory,
				sessionID: input.sessionID,
				dispatcher: input.dispatcher,
				generatedAgentNames: [...(input.generatedAgentNames ?? [])],
			});
			return undefined;
		};
		const directoryA = path.join(tmpDir, 'instance-a');
		const directoryB = path.join(tmpDir, 'instance-b');
		const dispatcherA = { dispatch: async () => ({}) } as ReviewModelDispatcher;
		const dispatcherB = { dispatch: async () => ({}) } as ReviewModelDispatcher;
		const namesA = [
			'alpha_architect',
			'alpha_reviewer',
			'alpha_critic_finding_validator',
		];
		const namesB = [
			'beta_architect',
			'beta_reviewer',
			'beta_critic_finding_validator',
		];
		const hookA = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: directoryA,
			dispatcher: dispatcherA,
			generatedAgentNames: namesA,
			injectAdvisory: () => {},
		});
		const hookB = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: directoryB,
			dispatcher: dispatcherB,
			generatedAgentNames: namesB,
			injectAdvisory: () => {},
		});

		namesA.splice(0, namesA.length, 'mutated_reviewer');
		swarmState.generatedAgentNames = ['global_reviewer'];
		await Promise.all([
			hookA.toolAfter(
				{ tool: 'update_task_status', sessionID: 'instance-session-a' },
				{ args: { task_id: '1.1', status: 'completed' } },
			),
			hookB.toolAfter(
				{ tool: 'update_task_status', sessionID: 'instance-session-b' },
				{ args: { task_id: '2.1', status: 'completed' } },
			),
		]);

		expect(calls).toEqual([
			{
				directory: directoryA,
				sessionID: 'instance-session-a',
				dispatcher: dispatcherA,
				generatedAgentNames: [
					'alpha_architect',
					'alpha_reviewer',
					'alpha_critic_finding_validator',
				],
			},
			{
				directory: directoryB,
				sessionID: 'instance-session-b',
				dispatcher: dispatcherB,
				generatedAgentNames: namesB,
			},
		]);
	});

	test('same-session in-flight and cooldown state is isolated per hook instance', async () => {
		const calls: string[] = [];
		_internals.runAutoReview = (input) => {
			calls.push(input.directory);
			return new Promise(() => {});
		};
		const directoryA = path.join(tmpDir, 'instance-state-a');
		const directoryB = path.join(tmpDir, 'instance-state-b');
		const hookA = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: directoryA,
			dispatcher,
			injectAdvisory: () => {},
		});
		const hookB = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: directoryB,
			dispatcher,
			injectAdvisory: () => {},
		});
		const complete = (hook: typeof hookA) =>
			hook.toolAfter(
				{ tool: 'update_task_status', sessionID: 'shared-session' },
				{ args: { task_id: '1.1', status: 'completed' } },
			);

		await complete(hookA);
		await complete(hookB);

		// Previous module-global state suppressed hook B because hook A owned the
		// same session key. Each plugin instance must schedule independently.
		expect(calls).toEqual([directoryA, directoryB]);
		hookA.resetTracking();
		hookB.resetTracking();

		calls.length = 0;
		_internals.runAutoReview = async (input) => {
			calls.push(input.directory);
			return undefined;
		};
		await complete(hookA);
		await Bun.sleep(0);
		await complete(hookB);
		expect(calls).toEqual([directoryA, directoryB]);
	});

	test('propagates the exact active architect for multi-swarm routing', async () => {
		let activeAgentName: string | undefined;
		let generatedAgentNames: string[] = [];
		_internals.runAutoReview = async (input) => {
			activeAgentName = input.activeAgentName;
			generatedAgentNames = [...(input.generatedAgentNames ?? [])];
			return undefined;
		};
		const names = [
			'alpha_architect',
			'alpha_reviewer',
			'alpha_critic_finding_validator',
			'longer_swarm_architect',
			'longer_swarm_reviewer',
			'longer_swarm_critic_finding_validator',
		];
		const hook = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: tmpDir,
			dispatcher,
			generatedAgentNames: names,
			getActiveAgentName: () => 'alpha_architect',
			injectAdvisory: () => {},
		});

		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 'alpha-session' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);

		expect(activeAgentName).toBe('alpha_architect');
		expect(generatedAgentNames).toEqual(names);
	});

	test('both still leaves phase/plan ownership to phase_complete body', async () => {
		const { hook, calls } = recordingHook(makeConfig({ trigger: 'both' }));
		await hook.toolAfter(
			{ tool: 'phase_complete', sessionID: 's1' },
			{ args: { phase: 1 } },
		);
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);
		expect(calls).toEqual([{ trigger: 'task_completion', taskId: '1.1' }]);
	});

	test('non-architect session never triggers', async () => {
		const { hook, calls } = recordingHook(
			makeConfig({ trigger: 'task_completion' }),
		);
		swarmState.activeAgent.set('s1', 'coder');
		await hook.toolAfter(
			{ tool: 'update_task_status', sessionID: 's1' },
			{ args: { task_id: '1.1', status: 'completed' } },
		);
		expect(calls).toHaveLength(0);
	});

	test('session-keyed cooldown suppresses repeated completion retries', async () => {
		const { hook, calls } = recordingHook(
			makeConfig({ trigger: 'task_completion' }),
		);
		let now = 1_000_000;
		_internals.now = () => now;
		const invoke = () =>
			hook.toolAfter(
				{ tool: 'update_task_status', sessionID: 's1' },
				{ args: { task_id: '1.1', status: 'completed' } },
			);
		await invoke();
		now += 10_000;
		await invoke();
		expect(calls).toHaveLength(1);
		now += 61_000;
		await invoke();
		expect(calls).toHaveLength(2);
	});

	test('caps active unique sessions, reports overflow, and reuses a rejected slot', async () => {
		const calls: string[] = [];
		const advisories: string[] = [];
		let rejectFirst: ((reason: Error) => void) | undefined;
		_internals.runAutoReview = (input) => {
			calls.push(input.sessionID);
			return new Promise((_, reject) => {
				if (input.sessionID === 'session-0') rejectFirst = reject;
			});
		};
		const hook = createAutoReviewHook({
			config: makeConfig({ trigger: 'task_completion' }),
			directory: tmpDir,
			dispatcher,
			injectAdvisory: (_sessionID, message) => advisories.push(message),
		});
		const complete = (sessionID: string) =>
			hook.toolAfter(
				{ tool: 'update_task_status', sessionID },
				{ args: { task_id: sessionID, status: 'completed' } },
			);

		for (let index = 0; index < 256; index++) {
			await complete(`session-${index}`);
		}
		await complete('session-overflow');

		expect(calls).toHaveLength(256);
		expect(calls).not.toContain('session-overflow');
		expect(readEvents().at(-1)).toMatchObject({
			session_id: 'session-overflow',
			verdict: 'skipped',
			model_calls: 0,
		});
		expect(readEvents().at(-1)?.detail).toContain(
			'active review capacity reached (256)',
		);
		expect(advisories.at(-1)).toContain('Completion remains fail-open');

		rejectFirst?.(new Error('injected scheduler rejection'));
		await Bun.sleep(0);
		expect(readEvents().at(-1)).toMatchObject({
			session_id: 'session-0',
			verdict: 'error',
			model_calls: 0,
		});
		expect(readEvents().at(-1)?.detail).toContain(
			'unexpected review scheduler rejection',
		);

		await complete('session-overflow');
		expect(calls).toHaveLength(257);
		expect(calls.at(-1)).toBe('session-overflow');
	});
});

describe('AutoReviewConfigSchema', () => {
	test('v7-safe defaults expose the full bounded review contract', () => {
		const parsed = AutoReviewConfigSchema.parse({});
		expect(parsed.enabled).toBe(false);
		expect(parsed.trigger).toBe('phase_boundary');
		expect(parsed.timeout_ms).toBe(300_000);
		expect(parsed.max_diff_kb).toBe(256);
		expect(parsed.min_confidence).toBe(0.7);
		expect(parsed.final_review.mode).toBe('advisory');
	});

	test('rejects out-of-range bounds', () => {
		expect(AutoReviewConfigSchema.safeParse({ timeout_ms: 1 }).success).toBe(
			false,
		);
		expect(
			AutoReviewConfigSchema.safeParse({ max_diff_kb: 99_999 }).success,
		).toBe(false);
		expect(
			AutoReviewConfigSchema.safeParse({ min_confidence: 2 }).success,
		).toBe(false);
	});
});
