/**
 * Tests for BUG-1 log reclassifications in model-limits.ts and context-budget.ts
 *
 * BUG-1a (model-limits.ts): Verifies that logFirstCall() calls log() not warn()
 * BUG-1b (context-budget.ts): Verifies that the startup diagnostic calls log() not warn()
 *
 * Mocks only src/utils/logger (not the barrel src/utils/index) to avoid
 * leaking a partial mock that strips SwarmError from later test files.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLog = mock(() => {});
const mockWarn = mock(() => {});
const mockCriticalWarn = mock(() => {});
const mockError = mock(() => {});

// Mock ONLY the logger module — the barrel re-export picks up the mock
// while keeping SwarmError and other exports intact.
mock.module('../../../src/utils/logger', () => ({
	log: mockLog,
	warn: mockWarn,
	criticalWarn: mockCriticalWarn,
	error: mockError,
}));

describe('log-level-reclassification', () => {
	beforeEach(() => {
		mockLog.mockClear();
		mockWarn.mockClear();
		mockCriticalWarn.mockClear();
		mockError.mockClear();
	});

	afterEach(() => {
		// CROSS-MODULE mock cleanup — no _internals seams in model-limits.ts or context-budget.ts
		mock.restore();
	});

	describe('model-limits', () => {
		it('BUG-1a: warn() NOT called for "Resolved limit for" message', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');
			resolveModelLimit('claude-sonnet-4-6-test-unique-1', 'anthropic', {});

			const warnCalls = mockWarn.mock.calls;
			const resolvedLimitWarnCall = warnCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes('Resolved limit for'),
				),
			);
			expect(resolvedLimitWarnCall).toBeUndefined();
		});

		it('BUG-1a: log() IS called for "Resolved limit for" message with model info', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');
			resolveModelLimit('claude-sonnet-4-6-test-unique-2', 'anthropic', {});

			expect(mockLog).toHaveBeenCalled();

			const logCalls = mockLog.mock.calls;
			const resolvedLimitCall = logCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' &&
						arg.includes('Resolved limit for') &&
						arg.includes('claude-sonnet-4-6-test-unique-2'),
				),
			);
			expect(resolvedLimitCall).toBeDefined();
		});

		it('BUG-1a: undefined modelID/providerID does NOT trigger warn() for "Resolved limit for"', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');
			resolveModelLimit(undefined, undefined, {});
			const warnCalls = mockWarn.mock.calls;
			const resolvedLimitWarnCall = warnCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes('Resolved limit for'),
				),
			);
			expect(resolvedLimitWarnCall).toBeUndefined();
		});

		it('warns once when an authored user_default is smaller than a larger live window', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');

			resolveModelLimit(
				'context-default-live-warning-1',
				'openai',
				{ default: 64000 },
				200000,
			);
			resolveModelLimit(
				'context-default-live-warning-1',
				'openai',
				{ default: 64000 },
				200000,
			);

			const warningCalls = mockWarn.mock.calls.filter((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' &&
						arg.includes('context_budget.model_limits.default=64000'),
				),
			);
			expect(warningCalls).toHaveLength(1);
		});

		it('does not warn for model-specific overrides even when the live window is larger', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');

			resolveModelLimit(
				'context-model-override-no-warning',
				'openai',
				{ 'context-model-override-no-warning': 64000 },
				200000,
			);

			const warningCalls = mockWarn.mock.calls.filter((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' &&
						arg.includes('context_budget.model_limits.default'),
				),
			);
			expect(warningCalls).toHaveLength(0);
		});

		it('evicts old warning identities instead of growing session-global state without bound', () => {
			const {
				resolveModelLimit,
			} = require('../../../src/hooks/model-limits.js');
			const firstModel = 'context-default-bounded-warning-0';

			for (let index = 0; index <= 256; index++) {
				resolveModelLimit(
					`context-default-bounded-warning-${index}`,
					'openai',
					{ default: 64000 },
					200000,
				);
			}
			resolveModelLimit(firstModel, 'openai', { default: 64000 }, 200000);

			const firstIdentityWarnings = mockWarn.mock.calls.filter((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes(`${firstModel}@openai`),
				),
			);
			expect(firstIdentityWarnings).toHaveLength(2);
		});
	});

	describe('context-budget', () => {
		it('BUG-1b: warn() NOT called for "Context budget:" startup diagnostic', async () => {
			const createContextBudgetHandler =
				require('../../../src/hooks/context-budget.js').createContextBudgetHandler;
			const handler = createContextBudgetHandler({
				context_budget: {
					enabled: true,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
				},
			});

			await handler(
				{},
				{
					messages: [
						{
							info: {
								role: 'assistant',
								modelID: 'gpt-4o',
								providerID: 'openai',
							},
							parts: [{ type: 'text', text: 'Hello world' }],
						},
						{
							info: { role: 'user', agent: 'architect' },
							parts: [{ type: 'text', text: 'A test message' }],
						},
					],
				},
			);

			const warnCalls = mockWarn.mock.calls;
			const contextBudgetWarnCall = warnCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes('[swarm] Context budget:'),
				),
			);
			expect(contextBudgetWarnCall).toBeUndefined();
		});

		it('BUG-1b: log() IS called for "Context budget:" with model and provider info', async () => {
			const createContextBudgetHandler =
				require('../../../src/hooks/context-budget.js').createContextBudgetHandler;
			const handler = createContextBudgetHandler({
				context_budget: {
					enabled: true,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
				},
			});

			await handler(
				{},
				{
					messages: [
						{
							info: {
								role: 'assistant',
								modelID: 'gpt-4o',
								providerID: 'openai',
							},
							parts: [{ type: 'text', text: 'Hello world' }],
						},
						{
							info: { role: 'user', agent: 'architect' },
							parts: [{ type: 'text', text: 'A test message' }],
						},
					],
				},
			);

			const logCalls = mockLog.mock.calls;
			const contextBudgetLogCall = logCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes('[swarm] Context budget:'),
				),
			);
			expect(contextBudgetLogCall).toBeDefined();

			const logMessage = (contextBudgetLogCall as any[])[0];
			expect(logMessage).toContain('model=gpt-4o');
			expect(logMessage).toContain('provider=openai');
		});

		it('BUG-1b: enabled:false returns no-op without calling log() or warn()', async () => {
			const createContextBudgetHandler =
				require('../../../src/hooks/context-budget.js').createContextBudgetHandler;
			const handler = createContextBudgetHandler({
				context_budget: { enabled: false },
			});
			await handler(
				{},
				{
					messages: [
						{
							info: {
								role: 'assistant',
								modelID: 'gpt-4o',
								providerID: 'openai',
							},
							parts: [{ type: 'text', text: 'Hello world' }],
						},
					],
				},
			);
			expect(mockLog).not.toHaveBeenCalled();
			expect(mockWarn).not.toHaveBeenCalled();
		});

		it('BUG-1b: empty messages array returns early without logging "Context budget:"', async () => {
			const createContextBudgetHandler =
				require('../../../src/hooks/context-budget.js').createContextBudgetHandler;
			const handler = createContextBudgetHandler({
				context_budget: {
					enabled: true,
					warn_threshold: 0.7,
					critical_threshold: 0.9,
				},
			});
			await handler({}, { messages: [] });
			const logCalls = mockLog.mock.calls;
			const contextBudgetLogCall = logCalls.find((call: any[]) =>
				call.some(
					(arg: any) =>
						typeof arg === 'string' && arg.includes('[swarm] Context budget:'),
				),
			);
			expect(contextBudgetLogCall).toBeUndefined();
		});
	});
});
