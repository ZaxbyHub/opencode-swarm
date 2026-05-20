/**
 * Tests for context-budget.ts log reclassification
 *
 * Mocks only src/utils/logger (not the barrel src/utils/index) to avoid
 * leaking a partial mock that strips SwarmError from later test files.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLog = mock(() => {});
const mockWarn = mock(() => {});
const mockError = mock(() => {});

mock.module('../../../src/utils/logger', () => ({
	log: mockLog,
	warn: mockWarn,
	error: mockError,
}));

describe('context-budget log reclassification', () => {
	beforeEach(() => {
		mockLog.mockClear();
		mockWarn.mockClear();
		mockError.mockClear();
	});

	afterEach(() => {
		// CROSS-MODULE mock cleanup — no _internals seam in context-budget.ts
		mock.restore();
	});

	const getCreateContextBudgetHandler = () => {
		return require('../../../src/hooks/context-budget.js')
			.createContextBudgetHandler;
	};

	it('first call with model/provider uses log() not warn() for startup diagnostic', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
			},
		};
		const messages = [
			{
				info: { role: 'assistant', modelID: 'gpt-4o', providerID: 'openai' },
				parts: [{ type: 'text', text: 'Hello world' }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'A test message' }],
			},
		];

		const handler = getCreateContextBudgetHandler()(config);
		await handler({}, { messages });

		const logCalls = mockLog.mock.calls;
		const contextBudgetLogCalls = logCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetLogCalls.length).toBeGreaterThan(0);

		const warnCalls = mockWarn.mock.calls;
		const contextBudgetWarnCalls = warnCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetWarnCalls.length).toBe(0);

		const logMessage = contextBudgetLogCalls[0][0];
		expect(logMessage).toContain('model=gpt-4o');
		expect(logMessage).toContain('provider=openai');
	});

	it('second call with same model/provider does not call log() again (deduplication)', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
			},
		};
		const messages = [
			{
				info: { role: 'assistant', modelID: 'gpt-4o', providerID: 'openai' },
				parts: [{ type: 'text', text: 'Hello world' }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'A test message' }],
			},
		];

		const handler = getCreateContextBudgetHandler()(config);
		await handler({}, { messages });
		await handler({}, { messages });

		const allLogCalls = mockLog.mock.calls;
		const contextBudgetLogCalls = allLogCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetLogCalls.length).toBe(1);
	});

	it('different model/provider combinations trigger new log() calls', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
			},
		};

		let handler = getCreateContextBudgetHandler()(config);
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
						parts: [{ type: 'text', text: 'Hello' }],
					},
					{
						info: { role: 'user', agent: 'architect' },
						parts: [{ type: 'text', text: 'Message 1' }],
					},
				],
			},
		);

		handler = getCreateContextBudgetHandler()(config);
		await handler(
			{},
			{
				messages: [
					{
						info: {
							role: 'assistant',
							modelID: 'claude-3-opus',
							providerID: 'anthropic',
						},
						parts: [{ type: 'text', text: 'Hello' }],
					},
					{
						info: { role: 'user', agent: 'architect' },
						parts: [{ type: 'text', text: 'Message 2' }],
					},
				],
			},
		);

		const allLogCalls = mockLog.mock.calls;
		const contextBudgetLogCalls = allLogCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetLogCalls.length).toBe(2);
	});

	it('threshold warnings still use warn() (regression test)', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.7,
				critical_threshold: 0.9,
			},
		};
		const messages = [
			{
				info: { role: 'assistant', modelID: 'gpt-4o', providerID: 'openai' },
				parts: [{ type: 'text', text: 'Hello' }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'A'.repeat(15000) }],
			},
		];

		const handler = getCreateContextBudgetHandler()(config);
		await handler({}, { messages });

		const warnCalls = mockWarn.mock.calls;
		const contextBudgetWarnCalls = warnCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetWarnCalls.length).toBe(0);

		const logCalls = mockLog.mock.calls;
		const contextBudgetLogCalls = logCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetLogCalls.length).toBeGreaterThan(0);
	});

	it('warn() is still called for context enforcement warnings', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.001,
				critical_threshold: 0.002,
				enforce: true,
			},
		};
		const messages = [
			{
				info: { role: 'assistant', modelID: 'gpt-4o', providerID: 'openai' },
				parts: [{ type: 'text', text: 'Hello' }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'A'.repeat(5000) }],
			},
		];

		const handler = getCreateContextBudgetHandler()(config);
		await handler({}, { messages });

		const warnCalls = mockWarn.mock.calls;
		const contextBudgetWarnCalls = warnCalls.filter((call: any[]) =>
			call[0]?.includes('[swarm] Context budget:'),
		);
		expect(contextBudgetWarnCalls.length).toBe(0);
	});

	it('warn() is still called for threshold injection warnings', async () => {
		const config = {
			context_budget: {
				enabled: true,
				warn_threshold: 0.0001,
				critical_threshold: 0.0002,
			},
		};
		const messages = [
			{
				info: { role: 'assistant', modelID: 'gpt-4o', providerID: 'openai' },
				parts: [{ type: 'text', text: 'Hello' }],
			},
			{
				info: { role: 'user', agent: 'architect' },
				parts: [{ type: 'text', text: 'A'.repeat(5000) }],
			},
		];

		const handler = getCreateContextBudgetHandler()(config);
		await handler({}, { messages });

		const lastUserMessage = messages[messages.length - 1];
		const textPart = lastUserMessage?.parts?.find(
			(p: any) => p.type === 'text',
		);
		expect(textPart?.text).toMatch(/\[CONTEXT (WARNING|CRITICAL):/);
	});
});
