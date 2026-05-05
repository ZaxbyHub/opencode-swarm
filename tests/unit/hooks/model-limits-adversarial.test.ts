/**
 * Adversarial tests for log reclassification in model-limits.ts
 *
 * Mocks only src/utils/logger to avoid leaking a partial mock.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const mockLog = mock(() => {});

mock.module('../../../src/utils/logger', () => ({
	log: mockLog,
	warn: mock(() => {}),
	error: mock(() => {}),
}));

import { resolveModelLimit } from '../../../src/hooks/model-limits';

describe('model-limits: adversarial/attack-vector tests', () => {
	beforeEach(() => {
		mockLog.mockClear();
	});

	afterEach(() => {
		// CROSS-MODULE mock cleanup — no _internals seam in model-limits.ts for logger
		mock.restore();
	});

	describe('Scenario 1: undefined inputs', () => {
		it('should not crash on undefined inputs and return fallback', () => {
			const result = resolveModelLimit(undefined, undefined, {});
			expect(result).toBe(128000);
		});
	});

	describe('Scenario 2: empty strings', () => {
		it('should not crash on empty strings and not call warn()', () => {
			const result = resolveModelLimit('', 'empty-string-provider', {});
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('empty-string-provider');
			expect(logCall[0]).toContain('fallback');
		});
	});

	describe('Scenario 3: null coercion', () => {
		it('should not crash on null coercion (null as any)', () => {
			const result = resolveModelLimit(
				null as any,
				'null-coercion-provider',
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('null-coercion-provider');
			expect(logCall[0]).toContain('fallback');
		});
	});

	describe('Scenario 4: very long modelID string', () => {
		it('should not crash on 1000+ character modelID', () => {
			const longModelID = 'long1000-' + 'a'.repeat(990);
			const result = resolveModelLimit(longModelID, '', {});
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain(longModelID);
		});

		it('should not crash on 10000+ character modelID (boundary test)', () => {
			const veryLongModelID = 'verylong10000-' + 'x'.repeat(9990);
			const result = resolveModelLimit(
				veryLongModelID,
				'verylong-provider',
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain('verylong10000-');
		});
	});

	describe('Scenario 5: injection-like characters', () => {
		it('should safely pass through backticks without crashing', () => {
			const maliciousModelID = 'backtick`${malicious}`';
			const maliciousProviderID = 'backtick`${attack}`';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
			const logCall = mockLog.mock.calls[0] as any[];
			expect(logCall[0]).toContain(maliciousModelID);
		});

		it('should safely pass through newlines without crashing', () => {
			const maliciousModelID = 'newlines\nmodel\nwith\nnewlines';
			const maliciousProviderID = 'newlines\rprovider\rwith\rcarriage';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely pass through null bytes and special chars without crashing', () => {
			const maliciousModelID = 'control\x00\x1f\x7fwith\x00control\x1bchars';
			const maliciousProviderID = 'control\t\tprovider';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely handle template literal injection attempts', () => {
			const maliciousModelID = 'template-${process.exit()}';
			const maliciousProviderID = 'template-${require("child_process")}';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});

		it('should safely handle ANSI escape sequences', () => {
			const maliciousModelID = 'ansi\x1b[31mmodel\x1b[0m';
			const maliciousProviderID = 'ansi\x1b[32mprovider\x1b[0m';
			const result = resolveModelLimit(
				maliciousModelID,
				maliciousProviderID,
				{},
			);
			expect(result).toBe(128000);
			expect(mockLog).toHaveBeenCalledTimes(1);
		});
	});
});
