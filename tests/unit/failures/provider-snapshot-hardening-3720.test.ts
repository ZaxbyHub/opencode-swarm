/**
 * #3177 snapshot hardening (PR #3720 review round 3):
 *   - a provider-chosen error.name is sanitized like the display message, so
 *     control and ANSI sequences never reach lane evidence or reviewer summaries;
 *   - a carrier snapshot whose retryClass is not a known enum is not honored
 *     (fail-closed to normal text classification).
 */
import { describe, expect, test } from 'bun:test';
import { classifyProviderFailure } from '../../../src/failures/invocation-failure';
import { readProviderMessageError } from '../../../src/failures/provider-message-error';

describe('#3177 provider snapshot hardening', () => {
	test('a provider-chosen error.name is sanitized (ANSI sequences do not reach the snapshot name)', () => {
		const snapshot = readProviderMessageError({
			error: {
				name: '\u001b[31mEvilName\u001b[0m',
				data: { message: 'boom' },
			},
		});
		expect(snapshot).toBeDefined();
		expect(snapshot?.name).not.toContain('\u001b');
		expect(snapshot?.name).toContain('EvilName');
	});

	test('a name that sanitizes to nothing falls back to the constant', () => {
		const snapshot = readProviderMessageError({
			error: { name: '\u001b[0m\u001b[2K', data: { message: 'boom' } },
		});
		expect(snapshot?.name).toBe('UnknownError');
	});

	test('a carrier snapshot with an unknown retryClass is not honored (fail-closed)', () => {
		const error = new Error('odd provider reply') as Error & {
			providerError?: unknown;
		};
		error.providerError = {
			name: 'APIError',
			category: 'provider.rate_limit',
			retryClass: 'bogus-retry-class',
			risk: 'low',
			message: 'odd provider reply',
		};
		const record = classifyProviderFailure(error);
		expect(record.category).not.toBe('provider.rate_limit');
		expect(record.retryClass).not.toBe('bogus-retry-class');
	});

	test('a carrier snapshot with an unknown risk is not honored (fail-closed)', () => {
		const error = new Error('odd provider reply') as Error & {
			providerError?: unknown;
		};
		error.providerError = {
			name: 'APIError',
			category: 'provider.rate_limit',
			retryClass: 'retry_same',
			risk: 'catastrophic',
			message: 'odd provider reply',
		};
		const record = classifyProviderFailure(error);
		expect(record.category).not.toBe('provider.rate_limit');
		expect(record.risk).not.toBe('catastrophic');
	});
});
