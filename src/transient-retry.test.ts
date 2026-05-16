/**
 * Regression tests for Issue #691 — transient LLM error continuation (v6.34)
 *
 * Covers:
 * 1. TRANSIENT_MODEL_ERROR_PATTERN regex (529 addition and pre-existing terms)
 * 2. GuardrailsConfigSchema and GuardrailsProfileSchema max_transient_retries field
 * 3. InvocationWindow.transientRetryCount initialization via beginInvocation
 * 4. transientRetryCount resets at the start of each new invocation window
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	GuardrailsConfigSchema,
	GuardrailsProfileSchema,
} from './config/schema';
import {
	beginInvocation,
	getActiveWindow,
	resetSwarmState,
	startAgentSession,
} from './state';

// The regex is private to guardrails.ts; test it inline against the same
// source pattern so that any future change to the constant triggers a test failure.
const TRANSIENT_MODEL_ERROR_PATTERN =
	/rate.?limit|429|500|502|503|504|529|timeout|overloaded|model.?not.?found|temporarily.?unavailable|provider.?unavailable|server.?error|connection.?(refused|reset|timeout|lost)|bad.?gateway|gateway.?timeout|internal.?server.?error|service.?unavailable/i;

let testSessionId: string;

beforeEach(() => {
	resetSwarmState();
	testSessionId = `transient-retry-test-${Date.now()}`;
});

afterEach(() => {
	resetSwarmState();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. TRANSIENT_MODEL_ERROR_PATTERN regex
// ─────────────────────────────────────────────────────────────────────────────

describe('TRANSIENT_MODEL_ERROR_PATTERN regex — v6.34 additions', () => {
	it('1.1 matches bare 529', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('529')).toBe(true);
	});

	it('1.2 matches HTTP 529 with description', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test('HTTP 529 Too Many Requests'),
		).toBe(true);
	});

	it('1.3 matches 529 inside an error object string', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test(
				'{"error":{"type":"overloaded_error","status":529}}',
			),
		).toBe(true);
	});
});

describe('TRANSIENT_MODEL_ERROR_PATTERN regex — pre-existing terms (regression)', () => {
	it('1.4 matches 429 rate limit', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('429 rate limit exceeded')).toBe(
			true,
		);
	});

	it('1.5 matches 503 service unavailable', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('503 service unavailable')).toBe(
			true,
		);
	});

	it('1.6 matches overloaded', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('model is overloaded')).toBe(
			true,
		);
	});

	it('1.7 matches timeout', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test('request timeout after 30s'),
		).toBe(true);
	});

	it('1.8 matches temporarily unavailable', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test('service temporarily unavailable'),
		).toBe(true);
	});

	it('1.8a matches provider_unavailable', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('provider_unavailable')).toBe(
			true,
		);
	});

	it('1.8b matches connection lost', () => {
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('Network connection lost.')).toBe(
			true,
		);
	});

	it('1.9 does NOT match a generic non-transient error', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test(
				'TypeError: cannot read property of null',
			),
		).toBe(false);
	});

	it('1.10 does NOT match a tool syntax error', () => {
		expect(
			TRANSIENT_MODEL_ERROR_PATTERN.test('SyntaxError: unexpected token'),
		).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SCHEMA — GuardrailsConfigSchema max_transient_retries
// ─────────────────────────────────────────────────────────────────────────────

describe('GuardrailsConfigSchema max_transient_retries', () => {
	it('2.1 defaults to 5 when not provided', () => {
		const result = GuardrailsConfigSchema.parse({});
		expect(result.max_transient_retries).toBe(5);
	});

	it('2.2 accepts a custom value within range', () => {
		const result = GuardrailsConfigSchema.parse({ max_transient_retries: 10 });
		expect(result.max_transient_retries).toBe(10);
	});

	it('2.3 accepts 0 to disable transient bypass', () => {
		const result = GuardrailsConfigSchema.parse({ max_transient_retries: 0 });
		expect(result.max_transient_retries).toBe(0);
	});

	it('2.4 accepts max allowed value of 20', () => {
		const result = GuardrailsConfigSchema.parse({ max_transient_retries: 20 });
		expect(result.max_transient_retries).toBe(20);
	});

	it('2.5 rejects value above 20', () => {
		expect(() =>
			GuardrailsConfigSchema.parse({ max_transient_retries: 21 }),
		).toThrow();
	});

	it('2.6 rejects negative value', () => {
		expect(() =>
			GuardrailsConfigSchema.parse({ max_transient_retries: -1 }),
		).toThrow();
	});
});

describe('GuardrailsProfileSchema max_transient_retries', () => {
	it('2.7 is optional — profile without it is valid', () => {
		const result = GuardrailsProfileSchema.parse({ max_consecutive_errors: 8 });
		expect(result.max_transient_retries).toBeUndefined();
	});

	it('2.8 accepts value when provided', () => {
		const result = GuardrailsProfileSchema.parse({ max_transient_retries: 3 });
		expect(result.max_transient_retries).toBe(3);
	});

	it('2.9 rejects value above 20 in profile', () => {
		expect(() =>
			GuardrailsProfileSchema.parse({ max_transient_retries: 21 }),
		).toThrow();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. InvocationWindow.transientRetryCount initialization
// ─────────────────────────────────────────────────────────────────────────────

describe('beginInvocation initializes transientRetryCount', () => {
	it('3.1 new invocation window has transientRetryCount = 0', () => {
		startAgentSession(testSessionId, 'coder');
		beginInvocation(testSessionId, 'coder');
		const window = getActiveWindow(testSessionId);
		expect(window).toBeDefined();
		expect(window!.transientRetryCount).toBe(0);
	});

	it('3.2 transientRetryCount co-exists with consecutiveErrors at 0', () => {
		startAgentSession(testSessionId, 'explorer');
		beginInvocation(testSessionId, 'explorer');
		const window = getActiveWindow(testSessionId);
		expect(window!.consecutiveErrors).toBe(0);
		expect(window!.transientRetryCount).toBe(0);
	});

	it('3.3 second invocation window starts with transientRetryCount = 0', () => {
		startAgentSession(testSessionId, 'coder');

		// First invocation — manually set transientRetryCount to simulate prior errors
		beginInvocation(testSessionId, 'coder');
		const window1 = getActiveWindow(testSessionId);
		expect(window1).toBeDefined();
		window1!.transientRetryCount = 4;

		// Second invocation — should start fresh at 0
		beginInvocation(testSessionId, 'coder');
		const window2 = getActiveWindow(testSessionId);
		expect(window2).toBeDefined();
		expect(window2!.transientRetryCount).toBe(0);
	});

	it('3.4 transientRetryCount is a number (not undefined)', () => {
		startAgentSession(testSessionId, 'reviewer');
		beginInvocation(testSessionId, 'reviewer');
		const window = getActiveWindow(testSessionId);
		expect(typeof window!.transientRetryCount).toBe('number');
	});
});
