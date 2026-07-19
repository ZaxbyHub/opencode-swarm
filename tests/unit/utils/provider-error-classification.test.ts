/**
 * Issue #1896 (sub-issue 3): the single-sourced provider-error classifier now
 * recognizes provider QUOTA/usage-limit exhaustion as a retry + fallback-eligible
 * class — but ONLY via `isTransientProviderError` (the dispatch classifier). The
 * narrow `TRANSIENT_MODEL_ERROR_PATTERN` that tool-output paths consume must NOT
 * match quota, so a bash `Disk quota exceeded` (EDQUOT) in tool stdout can never
 * false-trigger a bogus model fallback (plan-critic blocker M1).
 */

import { describe, expect, it } from 'bun:test';
import {
	extractStatusCode,
	isQuotaError,
	isTransientProviderError,
	QUOTA_ERROR_PATTERN,
	TRANSIENT_MODEL_ERROR_PATTERN,
} from '../../../src/utils/provider-error-classification';

describe('isTransientProviderError — transient + quota (#1896)', () => {
	const transient = [
		'429 Too Many Requests',
		'rate limit exceeded',
		'503 Service Unavailable',
		'model temporarily unavailable',
		'ECONNRESET',
		'gateway timeout',
	];
	for (const s of transient) {
		it(`classifies transient: ${s}`, () => {
			expect(isTransientProviderError(s)).toBe(true);
		});
	}

	const quota = [
		'insufficient_quota',
		'You have exceeded your usage limit',
		'402 Payment Required',
		'credit balance is too low',
		'out of credits',
		'quota exceeded for this model',
	];
	for (const s of quota) {
		it(`classifies quota as transient-eligible: ${s}`, () => {
			expect(isTransientProviderError(s)).toBe(true);
			expect(isQuotaError(s)).toBe(true);
		});
	}

	const permanent = [
		'401 Unauthorized',
		'invalid api key',
		'invalid_request_error: bad model id',
		'permission denied',
		'',
	];
	for (const s of permanent) {
		it(`classifies permanent: ${JSON.stringify(s)}`, () => {
			expect(isTransientProviderError(s)).toBe(false);
			expect(isQuotaError(s)).toBe(false);
		});
	}
});

describe('quota is separated from the narrow tool-output pattern (M1)', () => {
	it('the narrow TRANSIENT_MODEL_ERROR_PATTERN does NOT match quota text', () => {
		// This is the guarantee that guards the guardrails tool-output path: a
		// shell "Disk quota exceeded" cannot be read as a transient provider error.
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('Disk quota exceeded')).toBe(
			false,
		);
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('insufficient_quota')).toBe(
			false,
		);
		expect(TRANSIENT_MODEL_ERROR_PATTERN.test('402 Payment Required')).toBe(
			false,
		);
	});

	it('QUOTA_ERROR_PATTERN matches the quota phrasings', () => {
		expect(QUOTA_ERROR_PATTERN.test('Disk quota exceeded')).toBe(true);
		expect(QUOTA_ERROR_PATTERN.test('insufficient_quota')).toBe(true);
	});

	it('rate-limit (429) is transient but NOT flagged as quota', () => {
		expect(isTransientProviderError('429 rate limit')).toBe(true);
		expect(isQuotaError('429 rate limit')).toBe(false);
	});
});

describe('extractStatusCode', () => {
	it('extracts a transient status code', () => {
		expect(extractStatusCode('HTTP 429 rate limited')).toBe(429);
		expect(extractStatusCode('503 unavailable')).toBe(503);
	});
	it('returns null when no transient code present', () => {
		expect(extractStatusCode('all good')).toBeNull();
		expect(extractStatusCode('401 unauthorized')).toBeNull();
	});
});
