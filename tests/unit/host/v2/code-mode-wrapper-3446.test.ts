/**
 * #3446 — the v2 adapter marks the host's Code Mode `execute` wrapper per call
 * for the Full-Auto classifier. The mark is not proof of provenance (a v2 tool
 * event carries no owner field), so the pass-through is an operator opt-in.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PluginConfig } from '../../../../src/config';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../../src/full-auto/state';
import {
	isCodeModeWrapperCall,
	recordCodeModeWrapperCall,
	resetCodeModeWrapperCalls,
} from '../../../../src/hooks/code-mode-wrapper';
import { createFullAutoPermissionHook } from '../../../../src/hooks/full-auto-permission';
import {
	configureV2ToolBeforeBudget,
	resetV2ToolBeforeBudget,
} from '../../../../src/host/v2/hook-budget';
import { registerV2ToolHooks } from '../../../../src/host/v2/hooks';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../../src/host/v2/types';
import {
	resetSwarmState,
	_internals as stateInternals,
	swarmState,
} from '../../../../src/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

function makeHooksWith(overrides: Record<string, unknown>): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
		...overrides,
	} as unknown as V1HooksSubset;
}

function makeHooks(
	onBefore: (input: Record<string, unknown>) => void = () => {},
	onAfter: (input: Record<string, unknown>) => void = () => {},
): V1HooksSubset {
	return {
		tool: {},
		agent: {},
		config: async () => {},
		event: async () => {},
		dispose: async () => {},
		'tool.execute.before': async (input: unknown) => {
			onBefore(input as Record<string, unknown>);
		},
		'tool.execute.after': async (input: unknown) => {
			onAfter(input as Record<string, unknown>);
		},
	} as unknown as V1HooksSubset;
}

async function capture(hooks: V1HooksSubset) {
	const calls: Array<{
		name: string;
		cb: (event: V2ToolHookInput) => unknown;
	}> = [];
	const ctx = {
		tool: {
			transform: async () => ({ dispose: async () => {} }),
			reload: async () => {},
			hook: async (
				name: 'execute.before' | 'execute.after',
				cb: (event: V2ToolHookInput) => unknown,
			) => {
				calls.push({ name, cb });
				return { dispose: async () => {} };
			},
		},
	};
	await registerV2ToolHooks(ctx as never, hooks, '.', []);
	return {
		before: calls.find((c) => c.name === 'execute.before')?.cb,
		after: calls.find((c) => c.name === 'execute.after')?.cb,
	};
}

function event(overrides: Partial<V2ToolHookInput> = {}): V2ToolHookInput {
	return {
		tool: 'execute',
		sessionID: 's1',
		agent: 'architect',
		messageID: 'm1',
		id: 'c1',
		input: { code: 'return await tools.swarm_status({});' },
		...overrides,
	} as V2ToolHookInput;
}

afterEach(() => {
	resetCodeModeWrapperCalls();
	resetSwarmState();
});

describe('v2 adapter marks the Code Mode execute wrapper (#3446)', () => {
	test('marks an execute call with a string code program before the v1 chain runs', async () => {
		let markedWhenChainRan: boolean | undefined;
		const { before } = await capture(
			makeHooks(() => {
				markedWhenChainRan = isCodeModeWrapperCall('s1', 'c1');
			}),
		);
		await before?.(event());
		expect(markedWhenChainRan).toBe(true);
	});

	test('the mark is consumed by the before chain and cleared when it ends; the after hook clears defensively', async () => {
		const { before, after } = await capture(makeHooks());
		await before?.(event());
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(false);
		// Defensive: a mark recorded some other way is still dropped by the after hook.
		recordCodeModeWrapperCall('s1', 'c1');
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(true);
		await after?.(event({ status: 'completed', result: { content: 'ok' } }));
		expect(isCodeModeWrapperCall('s1', 'c1')).toBe(false);
	});

	test('does not mark execute without a string code argument', async () => {
		const { before } = await capture(makeHooks());
		for (const input of [undefined, {}, { code: 42 }, { command: 'ls' }]) {
			await before?.(event({ input, id: `c-${JSON.stringify(input)}` }));
			expect(isCodeModeWrapperCall('s1', `c-${JSON.stringify(input)}`)).toBe(
				false,
			);
		}
	});

	test('does not mark any other tool, even with a code argument', async () => {
		const { before } = await capture(makeHooks());
		await before?.(event({ tool: 'run_code', id: 'c9' }));
		await before?.(event({ tool: 'swarm_status', id: 'c10' }));
		expect(isCodeModeWrapperCall('s1', 'c9')).toBe(false);
		expect(isCodeModeWrapperCall('s1', 'c10')).toBe(false);
	});
});

describe('real v2 adapter + real Full-Auto permission hook (#3446)', () => {
	// A plugin/MCP tool literally named `execute` taking `{ code }` is
	// indistinguishable from the host wrapper on a v2 tool event (the event is
	// {tool, sessionID, agent, messageID, id, input}), so the only safe default
	// is to escalate; the operator can opt in.
	const SESSION = 'sess-adapter-hook-3446';
	const code = 'return await tools.swarm_status({});';
	let tmp: string;
	let origClient: typeof stateInternals.swarmState.opencodeClient;

	beforeEach(() => {
		tmp = canonicalMkdtemp('v2-hook-');
		fs.mkdirSync(path.join(tmp, '.swarm'), { recursive: true });
		origClient = stateInternals.swarmState.opencodeClient;
		stateInternals.swarmState.opencodeClient = null; // any critic dispatch fails closed
		swarmState.activeAgent.set(SESSION, 'architect');
	});

	afterEach(() => {
		stateInternals.swarmState.opencodeClient = origClient;
		swarmState.activeAgent.delete(SESSION);
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	function config(trust: boolean): PluginConfig {
		return {
			full_auto: {
				enabled: true,
				mode: 'supervised',
				fail_closed: true,
				permission_policy: {
					enabled: true,
					allow_defaults: true,
					...(trust ? { trust_code_mode_wrapper: true } : {}),
				},
				denials: { max_consecutive: 3, max_total: 20, on_limit: 'pause' },
			},
			agents: {},
		} as unknown as PluginConfig;
	}

	async function runThroughAdapter(trust: boolean, input: unknown) {
		startFullAutoRun(tmp, SESSION, { enabled: true });
		const permission = createFullAutoPermissionHook({
			config: config(trust),
			directory: tmp,
		});
		const hooks = makeHooks();
		(hooks as unknown as Record<string, unknown>)['tool.execute.before'] = (
			i: { tool: string; sessionID: string; callID: string },
			o: { args: unknown },
		) => permission.toolBefore(i, o);
		const { before } = await capture(hooks);
		return before?.(
			event({ tool: 'execute', sessionID: SESSION, id: 'real-1', input }),
		);
	}

	test('default: a colliding execute tool with { code } is escalated (run pauses without a critic)', async () => {
		await expect(runThroughAdapter(false, { code })).rejects.toThrow(
			/FULL_AUTO_BLOCKED: critic verdict BLOCKED.*opencodeClient unavailable/,
		);
		expect(loadFullAutoRunState(tmp, SESSION)?.status).toBe('paused');
	});

	test('opted in: the host wrapper around a single tool call passes and the run stays running', async () => {
		await runThroughAdapter(true, { code });
		expect(loadFullAutoRunState(tmp, SESSION)?.status).toBe('running');
	});

	test('opted in: a program that can reach the network is still escalated', async () => {
		await expect(
			runThroughAdapter(true, { code: "return await fetch('http://x');" }),
		).rejects.toThrow(
			/FULL_AUTO_BLOCKED: critic verdict BLOCKED.*opencodeClient unavailable/,
		);
		expect(loadFullAutoRunState(tmp, SESSION)?.status).toBe('paused');
	});
});

describe('mark lifetime on a failed before chain (#3446 review F-4)', () => {
	function rejectingHooks(delayMs = 0): V1HooksSubset {
		return makeHooksWith({
			'tool.execute.before': async () => {
				if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
				throw new Error('FULL_AUTO_BLOCKED: test rejection');
			},
		});
	}

	test('a rejected before chain does not leave the mark behind', async () => {
		const { before } = await capture(rejectingHooks());
		await expect(before?.(event({ id: 'rej-1' }))).rejects.toThrow(
			/FULL_AUTO_BLOCKED/,
		);
		expect(isCodeModeWrapperCall('s1', 'rej-1')).toBe(false);
	});

	test('a timed-out before chain does not leave the mark behind', async () => {
		configureV2ToolBeforeBudget({ oversight: { hook_timeout_ms: 30 } });
		const slow = makeHooksWith({
			'tool.execute.before': async () => {
				await new Promise((r) => setTimeout(r, 250));
			},
		});
		const { before } = await capture(slow);
		await expect(before?.(event({ id: 'slow-1' }))).rejects.toThrow(
			/exceeded budget/,
		);
		expect(isCodeModeWrapperCall('s1', 'slow-1')).toBe(false);
		resetV2ToolBeforeBudget();
	});

	test('the mark is present while the chain runs and gone afterwards', async () => {
		let during: boolean | undefined;
		const { before } = await capture(
			makeHooks(() => {
				during = isCodeModeWrapperCall('s1', 'life-1');
			}),
		);
		await before?.(event({ id: 'life-1' }));
		expect(during).toBe(true);
		expect(isCodeModeWrapperCall('s1', 'life-1')).toBe(false);
	});

	test('a nested call sharing the wrapper id does not matter once the wrapper chain finished', async () => {
		const { before } = await capture(makeHooks());
		await before?.(event({ id: 'shared-1' }));
		await before?.(event({ tool: 'swarm_status', id: 'shared-1', input: {} }));
		expect(isCodeModeWrapperCall('s1', 'shared-1')).toBe(false);
	});
});
