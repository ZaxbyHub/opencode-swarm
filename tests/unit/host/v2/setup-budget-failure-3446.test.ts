/**
 * #3446 review F-5 — a failed `full_auto.oversight` config read restores the
 * default hook budget (it must not keep a stale custom value) and queues an
 * operator-visible warning.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	configureV2ToolBeforeBudget,
	resetV2ToolBeforeBudget,
	resolveV2ToolBeforeBudgetMs,
	V2_TOOL_BEFORE_BASE_MS,
} from '../../../../src/host/v2/hook-budget';
import { _internals } from '../../../../src/host/v2/setup';
import {
	clearDeferredWarnings,
	getDeferredWarnings,
} from '../../../../src/services/warning-buffer';

beforeEach(() => {
	clearDeferredWarnings();
	resetV2ToolBeforeBudget();
});

afterEach(() => {
	clearDeferredWarnings();
	resetV2ToolBeforeBudget();
});

describe('v2 hook-budget config read', () => {
	test('a successful read applies the configured budget', async () => {
		await _internals.configureToolBeforeBudget('.', (async () => ({
			config: { full_auto: { oversight: { hook_timeout_ms: 400_000 } } },
		})) as never);
		expect(resolveV2ToolBeforeBudgetMs(false, '.')).toBe(400_000);
		expect(getDeferredWarnings()).toHaveLength(0);
		// Keyed by directory: another project does not inherit it.
		expect(resolveV2ToolBeforeBudgetMs(false, '/other')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
	});

	test('a failed read restores the defaults and queues a warning', async () => {
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 400_000 } },
			'.',
		);
		expect(resolveV2ToolBeforeBudgetMs(false, '.')).toBe(400_000);
		await _internals.configureToolBeforeBudget('.', (async () => {
			throw new Error('disk stalled');
		}) as never);
		expect(resolveV2ToolBeforeBudgetMs(false, '.')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(true, '.')).toBe(150_000);
		const warnings = getDeferredWarnings();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('disk stalled');
		expect(warnings[0]).toContain('default budgets apply');
	});

	test('a read that exceeds its own timeout also restores the defaults', async () => {
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 400_000 } },
			'.',
		);
		await _internals.configureToolBeforeBudget(
			'.',
			(() => new Promise(() => {})) as never,
		);
		expect(resolveV2ToolBeforeBudgetMs(false, '.')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(getDeferredWarnings().length).toBeGreaterThanOrEqual(1);
	}, 10_000);

	test('a failed read resets only that project, not another one', async () => {
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 400_000 } },
			'/proj/a',
		);
		configureV2ToolBeforeBudget(
			{ oversight: { hook_timeout_ms: 300_000 } },
			'/proj/b',
		);
		await _internals.configureToolBeforeBudget('/proj/a', (async () => {
			throw new Error('disk stalled');
		}) as never);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/a')).toBe(
			V2_TOOL_BEFORE_BASE_MS,
		);
		expect(resolveV2ToolBeforeBudgetMs(false, '/proj/b')).toBe(300_000);
	});
});
