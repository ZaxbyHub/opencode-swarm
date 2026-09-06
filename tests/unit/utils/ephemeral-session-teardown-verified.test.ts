import { describe, expect, mock, test } from 'bun:test';
import {
	type EphemeralSessionLifecycle,
	teardownEphemeralSessionVerified,
} from '../../../src/utils/ephemeral-session-teardown';

function fakeLifecycle(options?: {
	deleteImpl?: () => Promise<unknown>;
	getImpl?: () => Promise<unknown>;
	omitGet?: boolean;
}): EphemeralSessionLifecycle & { calls: string[] } {
	const calls: string[] = [];
	const lifecycle = {
		calls,
		abort: async () => {
			calls.push('abort');
		},
		delete: async () => {
			calls.push('delete');
			return options?.deleteImpl?.();
		},
		...(options?.omitGet
			? {}
			: {
					get: async () => {
						calls.push('get');
						return options?.getImpl?.();
					},
				}),
	};
	return lifecycle as EphemeralSessionLifecycle & { calls: string[] };
}

describe('teardownEphemeralSessionVerified (#2599)', () => {
	test('abort → delete → verify ordering on success', async () => {
		const lifecycle = fakeLifecycle({ getImpl: async () => ({}) });
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result).toEqual({ ok: true, sessionId: 'ses-1', attempts: 1 });
		expect(lifecycle.calls).toEqual(['abort', 'delete', 'get']);
	});

	test('get rejecting (session gone) verifies teardown', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: async () => {
				throw new Error('no such session');
			},
		});
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(true);
	});

	test('get returning an empty body verifies teardown', async () => {
		const lifecycle = fakeLifecycle({ getImpl: async () => ({}) });
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(true);
	});

	test('a non-empty body object (even empty data) means alive — pinned semantics', async () => {
		// BOT-3: get returning { data: {} } yields a defined, non-null body,
		// which sessionExists treats as PRESENT. This pins that boundary:
		// only undefined/null bodies (or get-throw) mean gone.
		const lifecycle = fakeLifecycle({
			deleteImpl: async () => {},
			getImpl: async () => ({ data: {} }),
		});
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
		}
	});

	test('surviving session: bounded retries then typed unverified failure', async () => {
		let deleteCalls = 0;
		const lifecycle = fakeLifecycle({
			deleteImpl: async () => {
				deleteCalls += 1;
			},
			getImpl: async () => ({ data: { id: 'ses-1' } }), // always alive
		});
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
			expect(result.sessionId).toBe('ses-1');
			expect(result.reason).toBe('session-survived-bounded-retries');
		}
		expect(deleteCalls).toBeGreaterThanOrEqual(2);
		expect(deleteCalls).toBeLessThanOrEqual(6);
	});

	test('missing session.get degrades to a typed get-unavailable failure, never ok', async () => {
		const lifecycle = fakeLifecycle({ omitGet: true });
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
			expect(result.reason).toBe('get-unavailable');
		}
	});

	test('the "is harmless" docstring claim is corrected in source', async () => {
		const fs = await import('node:fs');
		const source = fs.readFileSync(
			new URL(
				'../../../src/utils/ephemeral-session-teardown.ts',
				import.meta.url,
			),
			'utf-8',
		);
		expect(source).not.toContain('is harmless');
	});

	test('retry path skips repeated aborts (abort once, delete retried)', async () => {
		let deletesUntilGone = 2; // dies on the second delete
		const lifecycle = fakeLifecycle({
			deleteImpl: async () => {
				deletesUntilGone -= 1;
			},
			getImpl: async () => (deletesUntilGone <= 0 ? {} : { data: { id: 'x' } }),
		});
		void mock(() => {});
		const result = await teardownEphemeralSessionVerified(lifecycle, 'ses-1');
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.attempts).toBe(2);
		expect(lifecycle.calls.filter((c) => c === 'abort')).toHaveLength(1);
		expect(lifecycle.calls.filter((c) => c === 'delete')).toHaveLength(2);
	});
});
