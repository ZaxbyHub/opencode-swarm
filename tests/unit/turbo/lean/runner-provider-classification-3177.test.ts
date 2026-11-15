/**
 * #3177 finding A (AC1-AC3): the lean lane fallback classification consumes
 * the structured provider-error snapshot instead of re-deriving transient /
 * permanent from the bounded display string.
 *
 * - AC1/leg 1: dispatchLane's failure surfaces the structured carrier
 *   (statusCode 403 + category provider.authentication_configuration), and
 *   the error the fallback wrapper throws carries it.
 * - AC2/leg 2 (false transient, production path): a deterministic 403 whose
 *   provider text mentions "429 rate limit" never enters the fallback chain.
 * - AC3/leg 3 (false permanent, production path): a status-less rate limit
 *   whose keyword sits past the 512-byte display bound still fails over.
 */
import { describe, expect, test } from 'bun:test';
import {
	classifyProviderFailure,
	isRetryableProviderFailure,
} from '../../../../src/failures/invocation-failure';
import {
	providerMessageErrorToError,
	readProviderMessageError,
} from '../../../../src/failures/provider-message-error';
import {
	FALLBACK_MODEL,
	makeRunner3177Harness,
	PRIMARY_MODEL,
} from './runner-3177-fixtures';

describe('#3177 structured provider-failure classification', () => {
	test('AC1: the provider-refused lane failure carries the structured snapshot through the wrapper', async () => {
		const h = makeRunner3177Harness([
			{
				statusCode: 403,
				message: 'access denied; upstream reports 429 rate limit for this key',
			},
		]);
		try {
			const result = await h.runner.dispatchLane(
				{
					laneId: 'lane-1',
					taskIds: ['1.1'],
					files: ['src/a.ts'],
					agent: 'coder',
				},
				'coder',
			);
			expect(result.ok).toBe(false);
			expect(result.providerError).toBeDefined();
			expect(result.providerError?.statusCode).toBe(403);
			expect(result.providerError?.category).toBe(
				'provider.authentication_configuration',
			);
			expect(result.providerError?.retryClass).toBe('operator_action');
		} finally {
			h.cleanup();
		}
	}, 30_000);

	test('AC2: a deterministic 403 whose text mentions 429 never fails over (production chain)', async () => {
		const h = makeRunner3177Harness([
			{
				statusCode: 403,
				message: 'access denied; upstream reports 429 rate limit for this key',
			},
		]);
		try {
			await h.runner.runPhase(1);
			// Only the primary was ever dispatched; the fallback chain stayed cold.
			expect(h.promptModels).toEqual([PRIMARY_MODEL]);
			expect(h.promptModels).not.toContain(FALLBACK_MODEL);
		} finally {
			h.cleanup();
		}
	}, 30_000);

	test('AC3: a status-less rate limit truncated past the display bound still fails over (production chain)', async () => {
		const padding = 'x'.repeat(600);
		const h = makeRunner3177Harness([
			{ message: `${padding} request rejected: rate limit exceeded` },
		]);
		try {
			await h.runner.runPhase(1);
			// The lane ends failed (exhausted), but the fallback WAS
			// dispatched — the chain fired for the transient class.
			expect(h.promptModels).toEqual([PRIMARY_MODEL, FALLBACK_MODEL]);
		} finally {
			h.cleanup();
		}
	}, 30_000);

	test('classifier snapshot arm: the carrier snapshot governs over bounded display text', () => {
		const padding = 'x'.repeat(600);
		const info = {
			error: {
				name: 'AI_APICallError',
				data: { message: `${padding} request rejected: rate limit exceeded` },
			},
		};
		const snapshot = readProviderMessageError(info);
		expect(snapshot?.category).toBe('provider.rate_limit');
		expect(snapshot?.retryClass).toBe('retry_same');
		// The carrier error classifies retryable from the snapshot even though
		// its message (the bounded display) no longer contains the keyword.
		const carrier = providerMessageErrorToError('probe', snapshot!);
		expect(carrier.message).not.toContain('rate limit');
		const record = classifyProviderFailure(carrier);
		expect(record.category).toBe('provider.rate_limit');
		expect(isRetryableProviderFailure(record)).toBe(true);
	});

	test('classifier snapshot arm: fail-closed on unknown enum values and bare category props', () => {
		const junk = new Error(
			'session.prompt provider error: odd failure',
		) as Error & {
			category?: string;
			providerError?: unknown;
		};
		junk.category = 'provider.rate_limit'; // bare property — must be ignored
		expect(classifyProviderFailure(junk).category).not.toBe(
			'provider.rate_limit',
		);
		const badSnapshot = new Error('odd failure') as Error & {
			providerError?: unknown;
		};
		badSnapshot.providerError = {
			category: 'provider.made_up',
			retryClass: 'retry_same',
			risk: 'medium',
		};
		expect(classifyProviderFailure(badSnapshot).category).not.toBe(
			'provider.made_up',
		);
	});
});

test('abort arm outranks the carrier snapshot (F-003 pin)', () => {
	const snapshot = readProviderMessageError({
		error: {
			name: 'AI_APICallError',
			data: { statusCode: 429, message: 'rate limit' },
		},
	});
	expect(snapshot?.category).toBe('provider.rate_limit');
	const carrier = providerMessageErrorToError('probe', snapshot!);
	// Control: the carrier alone classifies retryable from the snapshot.
	expect(classifyProviderFailure(carrier).category).toBe('provider.rate_limit');
	// Abort-shaped carrier stays cancelled regardless of its snapshot.
	const aborted = providerMessageErrorToError('probe', snapshot!);
	aborted.name = 'AbortError';
	const record = classifyProviderFailure(aborted);
	expect(record.category).toBe('provider.cancelled');
	expect(record.retryClass).toBe('do_not_retry');
	expect(isRetryableProviderFailure(record)).toBe(false);
});

test('early-finish carrier snapshots round-trip (F-001 pin)', () => {
	const lengthSnapshot = readProviderMessageError({ finish: 'length' });
	expect(lengthSnapshot?.category).toBe('provider.output_length');
	expect(lengthSnapshot?.retryClass).toBe('do_not_retry');
	const lengthRecord = classifyProviderFailure(
		providerMessageErrorToError('probe', lengthSnapshot!),
	);
	expect(lengthRecord.category).toBe('provider.output_length');
	expect(lengthRecord.retryClass).toBe('do_not_retry');

	const filterSnapshot = readProviderMessageError({ finish: 'content-filter' });
	expect(filterSnapshot?.category).toBe('provider.content_filter');
	const filterRecord = classifyProviderFailure(
		providerMessageErrorToError('probe', filterSnapshot!),
	);
	expect(filterRecord.category).toBe('provider.content_filter');
	expect(filterRecord.retryClass).toBe('do_not_retry');
});
