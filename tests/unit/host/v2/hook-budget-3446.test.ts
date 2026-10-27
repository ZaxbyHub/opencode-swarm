/**
 * #3446 — the v2 tool.execute.before budget must outlast the Full-Auto
 * oversight dispatch it can contain, and be configurable.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	configureV2ToolBeforeBudget,
	resetV2ToolBeforeBudget,
	resolveV2ToolBeforeBudgetMs,
	V2_TOOL_BEFORE_BASE_MS,
	V2_TOOL_BEFORE_BUDGET_MAX_ENTRIES,
	V2_TOOL_BEFORE_MARGIN_MS,
	V2_TOOL_BEFORE_MAX_MS,
} from '../../../../src/host/v2/hook-budget';
import { registerV2ToolHooks } from '../../../../src/host/v2/hooks';
import type {
	V1HooksSubset,
	V2ToolHookInput,
} from '../../../../src/host/v2/types';
import { resetSwarmState } from '../../../../src/state';

afterEach(() => {
	resetV2ToolBeforeBudget();
	resetSwarmState();
});

describe('resolveV2ToolBeforeBudgetMs', () => {
	test('defaults to the 60 s base when Full-Auto is not running', () => {
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(V2_TOOL_BEFORE_BASE_MS);
	});

	test('follows the oversight deadline plus a margin while Full-Auto runs (default 120 s)', () => {
		expect(resolveV2ToolBeforeBudgetMs(true)).toBe(
			120_000 + V2_TOOL_BEFORE_MARGIN_MS,
		);
	});

	test('tracks a configured oversight total_timeout_ms', () => {
		configureV2ToolBeforeBudget({ oversight: { total_timeout_ms: 240_000 } });
		expect(resolveV2ToolBeforeBudgetMs(true)).toBe(
			240_000 + V2_TOOL_BEFORE_MARGIN_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(V2_TOOL_BEFORE_BASE_MS);
	});

	test('never drops below the base for a short oversight deadline', () => {
		configureV2ToolBeforeBudget({ oversight: { total_timeout_ms: 5_000 } });
		expect(resolveV2ToolBeforeBudgetMs(true)).toBe(V2_TOOL_BEFORE_BASE_MS);
	});

	test('an explicit hook_timeout_ms always wins', () => {
		configureV2ToolBeforeBudget({
			oversight: { total_timeout_ms: 120_000, hook_timeout_ms: 400_000 },
		});
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(400_000);
		expect(resolveV2ToolBeforeBudgetMs(true)).toBe(400_000);
	});

	test('is capped, and ignores junk values', () => {
		configureV2ToolBeforeBudget({ oversight: { hook_timeout_ms: 99_999_999 } });
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(V2_TOOL_BEFORE_MAX_MS);
		for (const junk of [undefined, null, 'x', -5, 0, Number.NaN]) {
			configureV2ToolBeforeBudget({
				oversight: { hook_timeout_ms: junk, total_timeout_ms: junk },
			});
			expect(resolveV2ToolBeforeBudgetMs(false)).toBe(V2_TOOL_BEFORE_BASE_MS);
			expect(resolveV2ToolBeforeBudgetMs(true)).toBe(
				120_000 + V2_TOOL_BEFORE_MARGIN_MS,
			);
		}
		configureV2ToolBeforeBudget(undefined);
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(V2_TOOL_BEFORE_BASE_MS);
	});
});

describe('per-directory budgets', () => {
	const A = { oversight: { hook_timeout_ms: 111_000 } };
	const B = {
		oversight: { total_timeout_ms: 200_000 },
	};

	test('each directory resolves its own budget', () => {
		configureV2ToolBeforeBudget(A, '/proj/a');
		configureV2ToolBeforeBudget(B, '/proj/b');
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/a')).toBe(111_000);
		expect(resolveV2ToolBeforeBudgetMs(true, '/proj/a')).toBe(111_000);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/b')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(true, '/proj/b')).toBe(
			200_000 + V2_TOOL_BEFORE_MARGIN_MS,
		);
	});

	test('resetting one directory leaves the other intact', () => {
		configureV2ToolBeforeBudget(A, '/proj/a');
		configureV2ToolBeforeBudget(A, '/proj/b');
		resetV2ToolBeforeBudget('/proj/a');
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/a')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/b')).toBe(111_000);
	});

	test('an unknown directory falls back to the default slot, then defaults', () => {
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/x')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		configureV2ToolBeforeBudget(A);
		configureV2ToolBeforeBudget(B, '/proj/b');
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/x')).toBe(111_000);
		expect(resolveV2ToolBeforeBudgetMs(false)).toBe(111_000);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/b')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
	});

	test('the map is bounded: the oldest directory is evicted', () => {
		const cap = V2_TOOL_BEFORE_BUDGET_MAX_ENTRIES;
		for (let i = 0; i < cap + 1; i++) {
			configureV2ToolBeforeBudget(A, `/proj/${i}`);
		}
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/0')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/1')).toBe(111_000);
		expect(resolveV2ToolBeforeBudgetMs(false, `/proj/${cap}`)).toBe(111_000);
		// Re-configuring an existing key never evicts.
		configureV2ToolBeforeBudget(A, '/proj/5');
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/1')).toBe(111_000);
	});
});

describe('v2 execute.before uses the resolved budget', () => {
	async function beforeHook(slowMs: number, dir = '.') {
		const hooks = {
			tool: {},
			agent: {},
			config: async () => {},
			event: async () => {},
			dispose: async () => {},
			'tool.execute.before': async () => {
				await new Promise((r) => setTimeout(r, slowMs));
			},
		} as unknown as V1HooksSubset;
		let cb: ((e: V2ToolHookInput) => unknown) | undefined;
		const ctx = {
			tool: {
				transform: async () => ({ dispose: async () => {} }),
				reload: async () => {},
				hook: async (
					name: string,
					callback: (e: V2ToolHookInput) => unknown,
				) => {
					if (name === 'execute.before') cb = callback;
					return { dispose: async () => {} };
				},
			},
		};
		await registerV2ToolHooks(ctx as never, hooks, dir, []);
		return cb as (e: V2ToolHookInput) => Promise<void>;
	}
	const event = {
		tool: 'swarm_status',
		sessionID: 's-budget',
		agent: 'architect',
		messageID: 'm1',
		id: 'c1',
		input: {},
	} as V2ToolHookInput;

	test('a chain slower than the configured budget fails with a message naming the setting', async () => {
		configureV2ToolBeforeBudget({ oversight: { hook_timeout_ms: 40 } });
		const cb = await beforeHook(300);
		await expect(cb(event)).rejects.toThrow(
			/tool\.execute\.before exceeded budget \(40 ms; set full_auto\.oversight\.hook_timeout_ms/,
		);
	});

	test('a chain within the configured budget completes', async () => {
		configureV2ToolBeforeBudget({ oversight: { hook_timeout_ms: 2_000 } });
		const cb = await beforeHook(30);
		await expect(cb(event)).resolves.toBeUndefined();
	});

	test('the adapter applies the budget of its own project directory', async () => {
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 40 } },
			'/proj/short',
		);
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 2_000 } },
			'/proj/long',
		);
		const short = await beforeHook(300, '/proj/short');
		const long = await beforeHook(300, '/proj/long');
		await expect(short(event)).rejects.toThrow(/exceeded budget \(40 ms/);
		await expect(long(event)).resolves.toBeUndefined();
	});
});
