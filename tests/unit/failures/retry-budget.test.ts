import { describe, expect, it } from 'bun:test';
import {
	dispatchWithModelFallback,
	ModelDispatchTimeoutError,
} from '../../../src/utils/model-dispatch-fallback';

const transient = () => ({ transient: true, reason: 'transient' });

describe('invocation retry budgets', () => {
	it('bounds attempts independently for each invocation', async () => {
		const attemptsByInvocation = new Map<string, number>();
		for (const invocationID of ['inv-1', 'inv-2']) {
			await expect(
				dispatchWithModelFallback({
					dispatch: async () => {
						attemptsByInvocation.set(
							invocationID,
							(attemptsByInvocation.get(invocationID) ?? 0) + 1,
						);
						throw new Error('503 unavailable');
					},
					classify: transient,
					maxTransientRetriesPerModel: 2,
					backoffMs: () => 0,
					sleep: async () => {},
				}),
			).rejects.toThrow('503 unavailable');
		}
		expect(attemptsByInvocation).toEqual(
			new Map([
				['inv-1', 3],
				['inv-2', 3],
			]),
		);
	});

	it('stops at the absolute deadline even when retry budget remains', async () => {
		let now = 0;
		let attempts = 0;
		await expect(
			dispatchWithModelFallback({
				dispatch: async () => {
					attempts += 1;
					now += 4;
					throw new Error('503 unavailable');
				},
				classify: transient,
				maxTransientRetriesPerModel: 10,
				deadlineAtMs: 5,
				now: () => now,
				backoffMs: () => 100,
				sleep: async (ms) => {
					now += ms;
				},
			}),
		).rejects.toBeInstanceOf(ModelDispatchTimeoutError);
		expect(attempts).toBe(1);
	});
});
