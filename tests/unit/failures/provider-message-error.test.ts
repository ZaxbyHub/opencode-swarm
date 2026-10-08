import { describe, expect, test } from 'bun:test';
import { classifyProviderFailure } from '../../../src/failures/invocation-failure';
import {
	formatProviderMessageError,
	providerMessageErrorToError,
	readProviderMessageError,
	throwIfProviderMessageError,
} from '../../../src/failures/provider-message-error';

const info = (error: unknown) => ({ id: 'msg-1', error });

describe('readProviderMessageError', () => {
	test('returns null when the message carries no provider error', () => {
		for (const value of [undefined, null, 'x', {}, info(undefined), info('x')])
			expect(readProviderMessageError(value)).toBeNull();
	});

	test('classifies the status and message through the canonical classifier', () => {
		expect(
			readProviderMessageError(
				info({ name: 'APIError', data: { statusCode: 403, message: 'nope' } }),
			),
		).toMatchObject({
			name: 'APIError',
			statusCode: 403,
			category: 'provider.authentication_configuration',
		});
		expect(
			readProviderMessageError(
				info({ name: 'APIError', data: { statusCode: 429, message: 'slow' } }),
			)?.category,
		).toBe('provider.rate_limit');
		expect(readProviderMessageError(info({}))).toMatchObject({
			name: 'UnknownError',
		});
	});
});

describe('providerMessageErrorToError', () => {
	test('keeps the category recoverable by classifyProviderFailure', () => {
		const read = readProviderMessageError(
			info({ name: 'APIError', data: { statusCode: 429, message: 'slow' } }),
		);
		if (!read) throw new Error('expected a provider error');
		const error = providerMessageErrorToError('Prompt failed', read);
		expect(error.message).toBe(
			formatProviderMessageError('Prompt failed', read),
		);
		expect(error.message).toContain('(HTTP 429)');
		expect(error.status).toBe(429);
		expect(classifyProviderFailure(error).category).toBe(read.category);
	});

	test('throwIfProviderMessageError throws only for a provider error', () => {
		expect(() =>
			throwIfProviderMessageError('p', info(undefined)),
		).not.toThrow();
		expect(() =>
			throwIfProviderMessageError(
				'p',
				info({ name: 'APIError', data: { statusCode: 503, message: 'down' } }),
			),
		).toThrow('p: APIError (HTTP 503)');
	});
});
