/**
 * Test for log reclassification in model-limits.ts
 *
 * Mocks only src/utils/logger to avoid leaking a partial mock.
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';

const mockLog = mock(() => {});
const mockWarn = mock(() => {});
const mockError = mock(() => {});

mock.module('../../../src/utils/logger', () => ({
	log: mockLog,
	warn: mockWarn,
	error: mockError,
}));

describe('model-limits: log reclassification', () => {
	afterEach(() => {
		// CROSS-MODULE mock cleanup — no _internals seam in model-limits.ts for logger
		mock.restore();
	});

	it('should call log() and NOT warn() for the "Resolved limit for" message on first call', () => {
		mockLog.mockClear();
		mockWarn.mockClear();

		const { resolveModelLimit } = require('../../../src/hooks/model-limits.js');
		resolveModelLimit('claude-sonnet-4-6', 'anthropic', {});

		expect(mockLog).toHaveBeenCalled();

		const logCalls = mockLog.mock.calls;
		const resolvedLimitCall = logCalls.find((call: any[]) =>
			call.some(
				(arg: any) =>
					typeof arg === 'string' && arg.includes('Resolved limit for'),
			),
		);
		expect(resolvedLimitCall).toBeDefined();

		expect(mockWarn).not.toHaveBeenCalled();
	});

	it('should not call log() again on second call with same model/provider (deduplication)', () => {
		const { resolveModelLimit } = require('../../../src/hooks/model-limits.js');

		mockLog.mockClear();
		mockWarn.mockClear();

		resolveModelLimit('gpt-5', 'openai', {});
		const callCountAfterFirst = mockLog.mock.calls.length;

		resolveModelLimit('gpt-5', 'openai', {});

		expect(mockLog.mock.calls.length).toBe(callCountAfterFirst);
	});
});
