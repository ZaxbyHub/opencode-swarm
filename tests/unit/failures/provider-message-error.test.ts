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

describe('readProviderMessageError field handling', () => {
	test('a message that sanitizes to nothing never falls back to raw text', () => {
		const read = readProviderMessageError(
			info({ name: 'APIError', data: { message: '\u001b\u001b\u0007' } }),
		);
		expect(read?.message).toBe('no message');
	});

	test('blank or non-string messages read as "no message"', () => {
		for (const message of ['   ', 42, undefined])
			expect(
				readProviderMessageError(info({ name: 'APIError', data: { message } }))
					?.message,
			).toBe('no message');
	});

	test('a non-finite or non-numeric statusCode is dropped', () => {
		for (const statusCode of [Number.NaN, Number.POSITIVE_INFINITY, '403'])
			expect(
				readProviderMessageError(
					info({ name: 'APIError', data: { statusCode, message: 'x' } }),
				),
			).not.toHaveProperty('statusCode');
	});

	test('the error name is bounded and an empty or non-string name is UnknownError', () => {
		expect(
			readProviderMessageError(info({ name: 'N'.repeat(100), data: {} }))?.name,
		).toHaveLength(64);
		for (const name of ['', 7])
			expect(readProviderMessageError(info({ name }))?.name).toBe(
				'UnknownError',
			);
	});

	test('format omits the HTTP part without a status', () => {
		const read = readProviderMessageError(
			info({ name: 'APIError', data: { message: 'boom' } }),
		);
		if (!read) throw new Error('expected a provider error');
		expect(formatProviderMessageError('p', read)).toBe('p: APIError: boom');
	});
});

describe('readProviderMessageError early finish', () => {
	test('finish "length" and "content-filter" are provider errors when info.error is absent', () => {
		expect(readProviderMessageError({ finish: 'length' })).toMatchObject({
			name: 'MessageOutputLengthError',
			category: 'provider.output_length',
		});
		expect(readProviderMessageError({ finish: 'LENGTH' })?.name).toBe(
			'MessageOutputLengthError',
		);
		expect(
			readProviderMessageError({ finish: 'content-filter' }),
		).toMatchObject({
			name: 'MessageContentFilterError',
			category: 'provider.content_filter',
		});
		expect(() =>
			throwIfProviderMessageError('p', { finish: 'length' }),
		).toThrow('MessageOutputLengthError');
	});

	test('a normal finish is not an error, and info.error wins over finish', () => {
		for (const finish of ['stop', 'tool-calls', '', 7, undefined])
			expect(readProviderMessageError({ finish })).toBeNull();
		expect(
			readProviderMessageError({
				finish: 'length',
				error: { name: 'APIError', data: { statusCode: 429, message: 'slow' } },
			})?.name,
		).toBe('APIError');
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
