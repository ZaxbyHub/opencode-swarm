import { afterEach, describe, expect, test } from 'bun:test';
import {
	_internals,
	isSafeNpmTag,
	main,
	NPM_DIST_TAGS_URL,
	resolveNpmLatestTag,
	runCheck,
} from '../../../scripts/check-host-contract';

function fakeFetch(
	body: string,
	init: ResponseInit = { status: 200 },
	seen: string[] = [],
): typeof fetch {
	return (async (input: string | URL | Request) => {
		seen.push(String(input));
		return new Response(body, init);
	}) as typeof fetch;
}

/** Resolve with a warn collector so the stderr reason is observable. */
async function resolveWithReasons(
	fetchImpl: typeof fetch,
): Promise<{ tag: string; reasons: string[] }> {
	const reasons: string[] = [];
	const tag = await resolveNpmLatestTag(fetchImpl, (line) =>
		reasons.push(line),
	);
	return { tag, reasons };
}

describe('host-contract check: npm latest-tag resolution', () => {
	test('reads `latest` from the small dist-tags endpoint, not the full packument', async () => {
		const seen: string[] = [];
		const tag = await resolveNpmLatestTag(
			fakeFetch(
				'{"latest":"1.18.35","beta":"2.0.0-beta.1"}',
				{ status: 200 },
				seen,
			),
		);
		expect(tag).toBe('1.18.35');
		expect(seen).toEqual([NPM_DIST_TAGS_URL]);
		expect(NPM_DIST_TAGS_URL).toContain(
			'/-/package/@opencode-ai/plugin/dist-tags',
		);
	});

	test('an oversized response (the 27 MB packument failure class) resolves to no tag', async () => {
		const huge = `{"latest":"1.0.0","pad":"${'x'.repeat(70 * 1024)}"}`;
		expect(await resolveNpmLatestTag(fakeFetch(huge))).toBe('');
	});

	test('a non-OK status, missing latest, or invalid JSON resolves to no tag', async () => {
		expect(await resolveNpmLatestTag(fakeFetch('{}', { status: 404 }))).toBe(
			'',
		);
		expect(await resolveNpmLatestTag(fakeFetch('{"beta":"2.0.0"}'))).toBe('');
		expect(await resolveNpmLatestTag(fakeFetch('{"latest":7}'))).toBe('');
		expect(await resolveNpmLatestTag(fakeFetch('not json'))).toBe('');
	});

	test('a thrown fetch resolves to no tag', async () => {
		const throwing = (async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		expect(await resolveNpmLatestTag(throwing)).toBe('');
	});

	test('an empty `latest` and an unreadable body each log their own reason', async () => {
		const empty = await resolveWithReasons(fakeFetch('{"latest":""}'));
		expect(empty.tag).toBe('');
		expect(empty.reasons).toHaveLength(1);
		expect(empty.reasons[0]).toContain('no string `latest`');
		const erroring = (async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						throw new Error('socket reset');
					},
				}),
			)) as unknown as typeof fetch;
		const unreadable = await resolveWithReasons(erroring);
		expect(unreadable.tag).toBe('');
		expect(unreadable.reasons).toHaveLength(1);
		expect(unreadable.reasons[0]).toContain('response unreadable');
	});

	test('each failure class logs a distinct one-line stderr reason and still returns an empty tag', async () => {
		const huge = `{"latest":"1.0.0","pad":"${'x'.repeat(70 * 1024)}"}`;
		const throwing = (async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		const cases: Array<[string, typeof fetch, string]> = [
			['http', fakeFetch('{}', { status: 503 }), 'HTTP 503'],
			['oversize', fakeFetch(huge), 'over 65536 bytes'],
			['bad json', fakeFetch('not json'), 'not valid JSON'],
			['missing latest', fakeFetch('{"beta":"1"}'), 'no string `latest`'],
			[
				'invalid tag',
				fakeFetch('{"latest":"../../x"}'),
				'not a safe version tag',
			],
			['network', throwing, 'request failed: network down'],
		];
		const seenReasons = new Set<string>();
		for (const [, impl, expected] of cases) {
			const { tag, reasons } = await resolveWithReasons(impl);
			expect(tag).toBe('');
			expect(reasons).toHaveLength(1);
			expect(reasons[0]).toContain(expected);
			seenReasons.add(reasons[0]);
		}
		expect(seenReasons.size).toBe(cases.length);
		const ok = await resolveWithReasons(fakeFetch('{"latest":"1.2.3"}'));
		expect(ok).toEqual({ tag: '1.2.3', reasons: [] });
	});

	test('a timed-out request reports the timeout reason', async () => {
		const hanging = ((_input: unknown, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(new Error('aborted')),
				);
			})) as unknown as typeof fetch;
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = ((fn: () => void) =>
			realSetTimeout(fn, 0)) as unknown as typeof setTimeout;
		try {
			const { tag, reasons } = await resolveWithReasons(hanging);
			expect(tag).toBe('');
			expect(reasons).toEqual([
				'host-contract: npm latest-tag unresolved: timed out after 20000ms',
			]);
		} finally {
			globalThis.setTimeout = realSetTimeout;
		}
	});
});

describe('host-contract check: npm tag is validated before URL interpolation', () => {
	const original = { ..._internals };
	afterEach(() => {
		Object.assign(_internals, original);
	});

	test('isSafeNpmTag accepts version-like tags and rejects path-shaped input', () => {
		for (const ok of ['1.2.3', '1.2.3-beta.1', 'v1.18.35', '1.0.0+build_5'])
			expect(isSafeNpmTag(ok)).toBe(true);
		for (const bad of [
			'../../x',
			'a/b',
			'a\\b',
			'1..2',
			'a..b',
			'a'.repeat(129),
			'..',
			'1.2.3?x=1',
			'1.2.3#frag',
			' 1.2.3',
			'-rf',
			'',
			7,
			null,
			undefined,
			{},
		])
			expect(isSafeNpmTag(bad)).toBe(false);
	});

	test('--emit-expected refuses an unsafe --as-tag before writing anything', async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: unknown) => {
			errors.push(String(line));
		};
		try {
			const code = await main([
				'--emit-expected',
				'does-not-exist.ts',
				'--as-tag',
				'../../x',
			]);
			expect(code).toBe(2);
			expect(errors.join('\n')).toContain('usage:');
		} finally {
			console.error = original;
		}
	});

	test('resolveNpmLatestTag treats an unsafe `latest` as unresolved', async () => {
		for (const latest of ['../../x', 'a/b', '', 7]) {
			const body = JSON.stringify({ latest });
			expect(await resolveNpmLatestTag(fakeFetch(body), () => {})).toBe('');
		}
		expect(
			await resolveNpmLatestTag(
				fakeFetch('{"latest":"1.2.3-beta.1"}'),
				() => {},
			),
		).toBe('1.2.3-beta.1');
	});

	test('runCheck names an unsafe tag on stderr, and stays quiet when nothing resolved', async () => {
		const errors: string[] = [];
		const original = console.error;
		console.error = (line: unknown) => {
			errors.push(String(line));
		};
		try {
			_internals.fetchHostSource = async () => null;
			await runCheck({ tag: '../../x' });
			expect(errors.join('\n')).toContain('refusing unsafe tag');
			errors.length = 0;
			_internals.resolveLatestTag = async () => '';
			await runCheck({});
			expect(errors).toEqual([]);
		} finally {
			console.error = original;
		}
	});

	test('runCheck never builds a source URL from an unsafe resolved or explicit tag', async () => {
		const fetched: string[] = [];
		_internals.fetchHostSource = async (tag: string) => {
			fetched.push(tag);
			return null;
		};
		for (const bad of ['../../x', 'a/b']) {
			_internals.resolveLatestTag = async () => bad;
			const viaResolver = await runCheck({});
			expect(viaResolver.lines).toContain('result=SOURCE_NOT_FOUND');
			const viaFlag = await runCheck({ tag: bad });
			expect(viaFlag.lines).toContain('result=SOURCE_NOT_FOUND');
		}
		expect(fetched).toEqual([]);
		_internals.resolveLatestTag = async () => '1.2.3';
		await runCheck({});
		expect(fetched).toEqual(['v1.2.3']);
	});
});
