import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GeneralCouncilConfig } from '../../../src/council/general-council-types';
import {
	createWebSearchProvider,
	SpecStreamProvider,
	WebSearchConfigError,
	WebSearchError,
} from '../../../src/council/web-search-provider';

interface Call {
	url: string;
	init?: RequestInit;
}

const REAL_FETCH = globalThis.fetch;
const SAVED_ENV = process.env.SPECSTREAM_API_KEY;
let calls: Call[];

function stubFetch(make: () => Response | Promise<Response>): void {
	globalThis.fetch = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		calls.push({ url: String(url), init });
		return make();
	}) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function headersOf(call: Call): Record<string, string> {
	return call.init?.headers as Record<string, string>;
}

beforeEach(() => {
	calls = [];
	delete process.env.SPECSTREAM_API_KEY;
});

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
	if (SAVED_ENV === undefined) delete process.env.SPECSTREAM_API_KEY;
	else process.env.SPECSTREAM_API_KEY = SAVED_ENV;
});

describe('SpecStreamProvider request shape', () => {
	test('GETs /v1/web-search with q and num and a Bearer key, never following redirects', async () => {
		stubFetch(() => jsonResponse({ data: { sources: [] } }));
		await new SpecStreamProvider('ss-FAKE').search('hello world & more', 7);
		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].url);
		expect(url.origin + url.pathname).toBe(
			'https://api.specstream.ai/v1/web-search',
		);
		expect(url.searchParams.get('q')).toBe('hello world & more');
		expect(url.searchParams.get('num')).toBe('7');
		expect([...url.searchParams.keys()].sort()).toEqual(['num', 'q']);
		expect(calls[0].init?.method).toBe('GET');
		expect(calls[0].init?.body).toBeUndefined();
		expect(calls[0].init?.redirect).toBe('error');
		const h = headersOf(calls[0]);
		expect(h.Authorization).toBe('Bearer ss-FAKE');
		expect(h.Accept).toBe('application/json');
	});

	test('a redirect refusal surfaces a redirect message and keeps the cause', async () => {
		const cause = new TypeError('fetch failed: redirect mode is set to error');
		stubFetch(() => {
			throw cause;
		});
		const err = await new SpecStreamProvider('ss-FAKE')
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as WebSearchError).message).toBe(
			'SpecStream request was redirected (refused)',
		);
		expect((err as WebSearchError).cause).toBe(cause);
	});
});

describe('SpecStreamProvider errors', () => {
	test('HTTP 401 throws WebSearchError without echoing the key', async () => {
		stubFetch(() =>
			jsonResponse({ error: { code: 'invalid_token', message: 'no' } }, 401),
		);
		const err = await new SpecStreamProvider('ss-SECRET')
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as Error).message).toBe('SpecStream HTTP 401 for query "q"');
		expect((err as Error).message).not.toContain('ss-SECRET');
	});

	test('HTTP 402 and 5xx throw WebSearchError with the status', async () => {
		for (const status of [402, 503]) {
			stubFetch(() => new Response('upstream', { status }));
			await expect(new SpecStreamProvider('k').search('q', 1)).rejects.toThrow(
				`SpecStream HTTP ${status} for query "q"`,
			);
		}
	});

	test('200 with a non-JSON body throws a non-JSON WebSearchError', async () => {
		stubFetch(() => new Response('<html>', { status: 200 }));
		await expect(new SpecStreamProvider('k').search('q', 1)).rejects.toThrow(
			'SpecStream returned non-JSON response',
		);
	});

	test('fetch rejection throws a network error with the cause', async () => {
		const cause = new Error('ECONNREFUSED');
		stubFetch(() => {
			throw cause;
		});
		const err = await new SpecStreamProvider('k')
			.search('q', 1)
			.catch((e: unknown) => e);
		expect((err as Error).message).toBe(
			'SpecStream network error for query "q"',
		);
		expect((err as WebSearchError).cause).toBe(cause);
	});
});

describe('SpecStreamProvider result mapping', () => {
	test('maps data.sources in order and ignores data.answer and data.rows', async () => {
		stubFetch(() =>
			jsonResponse({
				data: {
					kind: 'fact',
					answer: { value: 'January 22, 2025', page: 'https://example.com/a' },
					rows: [{ name: 'row', page: 'https://example.com/r' }],
					sources: [
						{
							url: 'https://go.dev/blog/swisstable',
							title: 'Faster Go maps with Swiss Tables',
							site: 'go.dev',
							snippet: 'Go 1.24 includes a new map.',
							published: '2025-02-26',
						},
						{
							url: 'https://example.com/b',
							title: 'Second',
							snippet: 'two',
						},
					],
				},
			}),
		);
		const results = await new SpecStreamProvider('k').search('go maps', 5);
		expect(results).toEqual([
			{
				title: 'Faster Go maps with Swiss Tables',
				url: 'https://go.dev/blog/swisstable',
				snippet: 'Go 1.24 includes a new map.',
				query: 'go maps',
			},
			{
				title: 'Second',
				url: 'https://example.com/b',
				snippet: 'two',
				query: 'go maps',
			},
		]);
	});

	test('missing data, non-array sources and malformed entries yield what is valid, never throw', async () => {
		for (const body of [null, {}, { data: null }, { data: { sources: 'x' } }]) {
			stubFetch(() => jsonResponse(body));
			expect(await new SpecStreamProvider('k').search('q', 1)).toEqual([]);
		}
		stubFetch(() =>
			jsonResponse({
				data: {
					sources: [
						null,
						{ url: 'https://a.example', snippet: 'no title' },
						{ title: 'no url', snippet: 's' },
						{ title: 'empty snippet', url: 'https://b.example', snippet: '' },
						{ title: 'no snippet', url: 'https://c.example' },
						{ title: 'kept', url: 'https://d.example', snippet: 'ok' },
					],
				},
			}),
		);
		expect(await new SpecStreamProvider('k').search('q', 6)).toEqual([
			{ title: 'kept', url: 'https://d.example', snippet: 'ok', query: 'q' },
		]);
	});

	test('freshness is not claimed', () => {
		expect(new SpecStreamProvider('k').supportsFreshness).toBe(false);
	});
});

describe('createWebSearchProvider with searchProvider "specstream"', () => {
	const base: GeneralCouncilConfig = {
		enabled: true,
		searchProvider: 'specstream',
		members: [],
		presets: {},
		deliberate: true,
		moderator: false,
		maxSourcesPerMember: 5,
	};

	test('without SPECSTREAM_API_KEY it throws a config error and sends nothing', () => {
		stubFetch(() => jsonResponse({}));
		expect(() => createWebSearchProvider(base)).toThrow(WebSearchConfigError);
		expect(() => createWebSearchProvider(base)).toThrow(/SPECSTREAM_API_KEY/);
		expect(calls).toHaveLength(0);
	});

	test('a blank or whitespace SPECSTREAM_API_KEY counts as unset', () => {
		process.env.SPECSTREAM_API_KEY = '   ';
		expect(() => createWebSearchProvider(base)).toThrow(WebSearchConfigError);
	});

	test('the shared searchApiKey is never sent to SpecStream', async () => {
		expect(() =>
			createWebSearchProvider({ ...base, searchApiKey: 'tvly-FAKE' }),
		).toThrow(WebSearchConfigError);

		process.env.SPECSTREAM_API_KEY = '  ss-FAKE  ';
		stubFetch(() => jsonResponse({ data: { sources: [] } }));
		const provider = createWebSearchProvider({
			...base,
			searchApiKey: 'tvly-FAKE',
		});
		expect(provider).toBeInstanceOf(SpecStreamProvider);
		await provider.search('q', 2);
		expect(headersOf(calls[0]).Authorization).toBe('Bearer ss-FAKE');
		expect(JSON.stringify(calls[0])).not.toContain('tvly-FAKE');
	});
});
