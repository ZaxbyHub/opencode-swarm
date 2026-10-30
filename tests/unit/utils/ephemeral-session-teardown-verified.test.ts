import { describe, expect, mock, test } from 'bun:test';
import {
	_internals,
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

// #2964: verify-timeout and transient transport failures are NOT confirmed
// session death — they return the typed unverified failure instead of ok:true.
describe('teardownEphemeralSessionVerified transient arm (#2964)', () => {
	test('S1: get never settling (alive session) returns typed verify-unreadable, never ok', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: () => new Promise(() => {}), // real mechanism: never settles
		});
		const result = await teardownEphemeralSessionVerified(
			lifecycle,
			'ses-alive-hang',
			{
				verifyTimeoutMs: 25,
			},
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
			expect(result.reason).toBe('verify-unreadable');
		}
	});

	test('S2: transport TypeError rejection returns typed verify-unreadable', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: async () => {
				throw new TypeError('fetch failed');
			},
		});
		const result = await teardownEphemeralSessionVerified(
			lifecycle,
			'ses-transport',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
			expect(result.reason).toBe('verify-unreadable');
		}
	});

	// Closed transport set, parameterized — 100% of seeded cases must be
	// not-proven.
	for (const tc of [
		{
			label: 'ECONNRESET',
			make: () => Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
		},
		{
			label: 'ECONNREFUSED',
			make: () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
		},
		{
			label: 'EAI_AGAIN',
			make: () => Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }),
		},
		{
			label: 'ETIMEDOUT',
			make: () => Object.assign(new Error('slow'), { code: 'ETIMEDOUT' }),
		},
		{
			label: 'ENOTFOUND',
			make: () => Object.assign(new Error('nx'), { code: 'ENOTFOUND' }),
		},
		{
			label: 'EPIPE',
			make: () => Object.assign(new Error('pipe'), { code: 'EPIPE' }),
		},
		{
			label: 'UND_ERR_SOCKET',
			make: () =>
				Object.assign(new Error('undici'), { code: 'UND_ERR_SOCKET' }),
		},
		{
			label: 'AbortError',
			make: () => Object.assign(new Error('aborted'), { name: 'AbortError' }),
		},
		{ label: 'TypeError', make: () => new TypeError('fetch failed') },
	] as const) {
		test(`transport matrix: rejecting ${tc.label} never claims death`, async () => {
			const lifecycle = fakeLifecycle({
				getImpl: async () => {
					throw tc.make();
				},
			});
			const result = await teardownEphemeralSessionVerified(
				lifecycle,
				'ses-matrix',
			);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.kind).toBe('ephemeral-session-teardown-unverified');
				expect(result.reason).toBe('verify-unreadable');
			}
		});
	}

	// v2-host arm: the v2 session shim normalizes host rejections to
	// `{data: null, error}` envelopes (src/host/v2/session-client.ts).
	test('v2 envelope: resolved {data:null, error:TypeError} is verify-unreadable', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: async () => ({
				data: null,
				error: new TypeError('fetch failed'),
			}),
		});
		const result = await teardownEphemeralSessionVerified(
			lifecycle,
			'ses-v2-transport',
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.kind).toBe('ephemeral-session-teardown-unverified');
			expect(result.reason).toBe('verify-unreadable');
		}
	});

	test('v2 envelope control: resolved {data:null, error:plain Error} stays ok (host answered)', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: async () => ({ data: null, error: new Error('host said no') }),
		});
		const result = await teardownEphemeralSessionVerified(
			lifecycle,
			'ses-v2-answered',
		);
		expect(result.ok).toBe(true);
	});

	test('v2 envelope control: resolved {data:null} with no error stays ok (absent session)', async () => {
		const lifecycle = fakeLifecycle({
			getImpl: async () => ({ data: null }),
		});
		const result = await teardownEphemeralSessionVerified(
			lifecycle,
			'ses-v2-absent',
		);
		expect(result.ok).toBe(true);
	});

	test('isTransientTransportError boundary cases', () => {
		const classify = _internals.isTransientTransportError;
		expect(classify(undefined)).toBe(false);
		expect(classify(null)).toBe(false);
		expect(classify('ECONNRESET')).toBe(false); // non-object
		expect(classify(new Error('no such session'))).toBe(false); // plain Error
		expect(classify(new TypeError('fetch failed'))).toBe(true);
		expect(
			classify(Object.assign(new Error('r'), { code: 'ECONNRESET' })),
		).toBe(true);
		expect(classify(Object.assign(new Error('r'), { code: 'EBADTHING' }))).toBe(
			false,
		); // closed set
		expect(
			classify(Object.assign(new Error('a'), { name: 'AbortError' })),
		).toBe(true);
		expect(classify({ code: 'EPIPE' })).toBe(true); // non-Error object with code
	});
});
