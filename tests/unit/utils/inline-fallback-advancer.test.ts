/**
 * Issue #1905: unit tests for the shared inline fallback advancer
 * (`src/utils/inline-fallback-advancer.ts`). The helper is a pure extraction of
 * the advance block shared by `src/full-auto/oversight.ts:543–579` and the new
 * site at `src/hooks/full-auto-intercept.ts`. These tests pin the three branches
 * (chain exhausted, malformed skip, clean adopt) and the reason tagging.
 */
import { describe, expect, mock, test } from 'bun:test';
import { advanceInlineFallback } from '../../../src/utils/inline-fallback-advancer';

describe('advanceInlineFallback (#1905)', () => {
	test('chain exhausted — returns current index and no adoption', () => {
		const onAdopt = mock(() => {});
		const result = advanceInlineFallback({
			resolveFallback: () => null,
			index: 0,
			lastError: new Error('429 insufficient_quota'),
			onAdopt,
		});

		expect(result.nextIndex).toBe(0);
		expect(result.adopted).toBeNull();
		expect(onAdopt).not.toHaveBeenCalled();
	});

	test('clean adopt — index advances and override is parsed', () => {
		const onAdopt = mock(() => {});
		const result = advanceInlineFallback({
			resolveFallback: (i) => (i === 1 ? 'prov/fb1' : null),
			index: 0,
			lastError: new Error('429 insufficient_quota'),
			onAdopt,
		});

		expect(result.nextIndex).toBe(1);
		expect(result.adopted).not.toBeNull();
		expect(result.adopted?.modelString).toBe('prov/fb1');
		expect(result.adopted?.override).toEqual({
			providerID: 'prov',
			modelID: 'fb1',
		});
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[0]).toEqual({
			toModel: 'prov/fb1',
			fallbackIndex: 1,
			reason: 'quota',
		});
	});

	test('quota error → reason is "quota"', () => {
		const onAdopt = mock(() => {});
		advanceInlineFallback({
			resolveFallback: () => 'prov/fb1',
			index: 0,
			lastError: new Error('insufficient_quota: usage limit exceeded'),
			onAdopt,
		});

		expect(onAdopt.mock.calls[0]?.[0]?.reason).toBe('quota');
	});

	test('transient (non-quota) error → reason is "transient_model_error"', () => {
		const onAdopt = mock(() => {});
		advanceInlineFallback({
			resolveFallback: () => 'prov/fb1',
			index: 0,
			lastError: new Error('503 temporarily unavailable'),
			onAdopt,
		});

		expect(onAdopt.mock.calls[0]?.[0]?.reason).toBe('transient_model_error');
	});

	test('malformed entry (no provider/model separator) is skipped — index advances, override unchanged', () => {
		// parseModelString throws on a value with no `/` separator.
		const onAdopt = mock(() => {});
		const result = advanceInlineFallback({
			resolveFallback: () => 'no-separator-string',
			index: 0,
			lastError: new Error('429 insufficient_quota'),
			onAdopt,
		});

		// Index advances (so the malformed entry is not re-resolved on the next
		// retry) but no override is adopted — the caller keeps its current model.
		expect(result.nextIndex).toBe(1);
		expect(result.adopted).toBeNull();
		expect(onAdopt).not.toHaveBeenCalled();
	});

	test('works from a non-zero starting index (mid-chain recovery)', () => {
		const onAdopt = mock(() => {});
		const result = advanceInlineFallback({
			resolveFallback: (i) => (i === 3 ? 'prov/fb3' : null),
			index: 2,
			lastError: new Error('503 service unavailable'),
			onAdopt,
		});

		expect(result.nextIndex).toBe(3);
		expect(result.adopted?.modelString).toBe('prov/fb3');
		expect(onAdopt.mock.calls[0]?.[0]?.fallbackIndex).toBe(3);
	});

	test('handles a non-Error lastError (String() coercion path)', () => {
		const onAdopt = mock(() => {});
		advanceInlineFallback({
			resolveFallback: () => 'prov/fb1',
			index: 0,
			lastError: { weird: 'object' },
			onAdopt,
		});

		// No quota/transient token in "[object Object]" → transient_model_error
		// is NOT the right tag here (the caller would not have called this for a
		// non-transient error), but the classifier must not crash on non-Error.
		expect(onAdopt).toHaveBeenCalledTimes(1);
		expect(onAdopt.mock.calls[0]?.[0]?.reason).toBe('transient_model_error');
	});
});
