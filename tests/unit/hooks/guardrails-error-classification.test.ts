import { describe, expect, test } from 'bun:test';
import {
	classifyProviderFailure,
	classifyToolInvocationFailure,
	isRetryableProviderFailure,
} from '../../../src/failures/invocation-failure.js';

describe('source-aware failure classification (#2103)', () => {
	for (const signal of [
		{ status: 429, message: 'rate limited' },
		{ status: 503, message: 'service unavailable' },
		{ code: 'ECONNRESET', message: 'network connection lost' },
		{ message: 'quota exceeded' },
	]) {
		test(`provider channel marks ${JSON.stringify(signal)} retryable`, () => {
			expect(isRetryableProviderFailure(classifyProviderFailure(signal))).toBe(
				true,
			);
		});
	}

	for (const output of [
		'429 rate limited',
		'503 service unavailable',
		'quota exceeded',
		'context length exceeded',
	]) {
		test(`tool channel does not acquire provider authority: ${output}`, () => {
			const record = classifyToolInvocationFailure({
				tool: 'bash',
				args: { command: 'run-check' },
				output,
				error: 'command failed',
				metadata: { exit: 2 },
			});
			expect(record).toMatchObject({ source: 'shell', category: 'shell.exit' });
		});
	}

	test('provider content policy is permanent and fallback-ineligible', () => {
		const record = classifyProviderFailure({
			status: 400,
			code: 'content_policy_violation',
			message: 'content policy violation',
		});
		expect(record).toMatchObject({
			category: 'provider.content_policy',
			retryClass: 'do_not_retry',
		});
		expect(isRetryableProviderFailure(record)).toBe(false);
	});
});
