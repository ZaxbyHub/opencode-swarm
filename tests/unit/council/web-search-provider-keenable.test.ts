import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { GeneralCouncilConfig } from '../../../src/council/general-council-types';
import {
	BraveProvider,
	createWebSearchProvider,
	KeenableProvider,
	SpecStreamProvider,
	TavilyProvider,
	WebSearchError,
} from '../../../src/council/web-search-provider';

interface Call {
	url: string;
	init?: RequestInit;
}

const REAL_FETCH = globalThis.fetch;
const SAVED_ENV = process.env.KEENABLE_API_KEY;
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
	delete process.env.KEENABLE_API_KEY;
});

afterEach(() => {
	globalThis.fetch = REAL_FETCH;
	if (SAVED_ENV === undefined) delete process.env.KEENABLE_API_KEY;
	else process.env.KEENABLE_API_KEY = SAVED_ENV;
});

describe('KeenableProvider request shape', () => {
	test('POSTs {query, max_results} exactly with the expected headers', async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		await new KeenableProvider().search('hello world', 3);
		expect(calls).toHaveLength(1);
		expect(calls[0].init?.method).toBe('POST');
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({
			query: 'hello world',
			max_results: 3,
		});
		const h = headersOf(calls[0]);
		expect(h.Accept).toBe('application/json');
		expect(h['Content-Type']).toBe('application/json');
		expect(h['X-Keenable-Title']).toBe('opencode-swarm');
	});

	test('passes max_results through for a different value', async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		await new KeenableProvider().search('q', 9);
		expect(JSON.parse(String(calls[0].init?.body)).max_results).toBe(9);
	});

	test('refuses redirects on keyed and keyless requests', async () => {
		stubFetch(() => jsonResponse({ results: [] }));
		await new KeenableProvider().search('q', 1);
		await new KeenableProvider('kb-FAKE').search('q', 1);
		expect(calls[0].init?.redirect).toBe('error');
		expect(calls[1].init?.redirect).toBe('error');
	});

	test('a redirect refusal surfaces a redirect message and keeps the cause', async () => {
		const cause = new TypeError('fetch failed: redirect mode is set to error');
		globalThis.fetch = (async () => {
			throw cause;
		}) as unknown as typeof fetch;
		const err = await new KeenableProvider('kb-FAKE')
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as WebSearchError).message).toBe(
			'Keenable request was redirected (refused)',
		);
		expect((err as WebSearchError).cause).toBe(cause);
	});

	test('a runtime that reports the refusal only through the error code is still recognised', async () => {
		const cause = Object.assign(new TypeError('fetch failed'), {
			code: 'UnexpectedRedirect',
		});
		globalThis.fetch = (async () => {
			throw cause;
		}) as unknown as typeof fetch;
		const err = await new KeenableProvider()
			.search('q', 1)
			.catch((e: unknown) => e);
		expect((err as WebSearchError).message).toBe(
			'Keenable request was redirected (refused)',
		);
		expect((err as WebSearchError).cause).toBe(cause);
	});
});

describe('KeenableProvider failures', () => {
	test('HTTP 429 with a JSON body throws WebSearchError', async () => {
		stubFetch(() => jsonResponse({ error: 'rate limited' }, 429));
		const err = await new KeenableProvider()
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as Error).message).toMatch(/Keenable HTTP 429/);
	});

	test('HTTP 401 throws WebSearchError', async () => {
		stubFetch(() => new Response('nope', { status: 401 }));
		await expect(
			new KeenableProvider('kb-FAKE').search('q', 1),
		).rejects.toThrow(/Keenable HTTP 401/);
	});

	test('200 with a non-JSON body throws a non-JSON WebSearchError', async () => {
		stubFetch(() => new Response('<html>oops', { status: 200 }));
		const err = await new KeenableProvider()
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as Error).message).toBe('Keenable returned non-JSON response');
		expect((err as WebSearchError).cause).toBeDefined();
	});

	test('fetch rejection throws a network error with the cause', async () => {
		const cause = new TypeError('network down');
		globalThis.fetch = (async () => {
			throw cause;
		}) as unknown as typeof fetch;
		const err = await new KeenableProvider()
			.search('q', 1)
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebSearchError);
		expect((err as Error).message).toMatch(/^Keenable network error/);
		expect((err as WebSearchError).cause).toBe(cause);
	});
});

describe('KeenableProvider response mapping', () => {
	test('non-array results and null body yield []', async () => {
		stubFetch(() => jsonResponse({ results: 'nope' }));
		expect(await new KeenableProvider().search('q', 1)).toEqual([]);
		stubFetch(() => new Response('null', { status: 200 }));
		expect(await new KeenableProvider().search('q', 1)).toEqual([]);
		stubFetch(() => jsonResponse({}));
		expect(await new KeenableProvider().search('q', 1)).toEqual([]);
	});

	test('malformed entries are skipped without throwing', async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					null,
					{ title: 5, url: 'https://x.example', snippet: 's' },
					{ title: 'T', url: 7, snippet: 's' },
					{ title: 'ok', url: 'https://ok.example', snippet: 'good' },
				],
			}),
		);
		expect(await new KeenableProvider().search('q', 5)).toEqual([
			{ title: 'ok', url: 'https://ok.example', snippet: 'good', query: 'q' },
		]);
	});

	test('snippet is preferred over description', async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{
						title: 'T',
						url: 'https://t.example',
						snippet: 'S',
						description: 'D',
					},
				],
			}),
		);
		const [r] = await new KeenableProvider().search('q', 1);
		expect(r.snippet).toBe('S');
	});

	test('results with an empty or missing snippet are dropped (Tavily/Brave parity)', async () => {
		stubFetch(() =>
			jsonResponse({
				results: [
					{ title: 'A', url: 'https://a.example' },
					{
						title: 'B',
						url: 'https://b.example',
						snippet: '',
						description: '',
					},
					{ title: 'C', url: 'https://c.example', description: 'kept' },
				],
			}),
		);
		const results = await new KeenableProvider().search('q', 5);
		expect(results.map((r) => r.url)).toEqual(['https://c.example']);
	});
});

describe('createWebSearchProvider keenable credential scoping', () => {
	const base: GeneralCouncilConfig = {
		enabled: true,
		searchProvider: 'keenable',
		members: [],
		presets: {},
		deliberate: true,
		moderator: false,
		maxSourcesPerMember: 5,
	};

	async function run(config: GeneralCouncilConfig): Promise<Call> {
		stubFetch(() => jsonResponse({ results: [] }));
		await createWebSearchProvider(config).search('q', 2);
		return calls[0];
	}

	test('shared inline searchApiKey is never forwarded to Keenable', async () => {
		const call = await run({ ...base, searchApiKey: 'tvly-FAKE' });
		expect(call.url).toBe('https://api.keenable.ai/v1/search/public');
		expect(headersOf(call)['X-API-Key']).toBeUndefined();
		expect(JSON.stringify(call.init)).not.toContain('tvly-FAKE');
	});

	test('KEENABLE_API_KEY selects the keyed endpoint with X-API-Key', async () => {
		process.env.KEENABLE_API_KEY = 'kb-FAKE';
		const call = await run(base);
		expect(call.url).toBe('https://api.keenable.ai/v1/search');
		expect(headersOf(call)['X-API-Key']).toBe('kb-FAKE');
	});

	test('KEENABLE_API_KEY is trimmed and the inline key is still ignored', async () => {
		process.env.KEENABLE_API_KEY = '  kb-FAKE  ';
		const call = await run({ ...base, searchApiKey: 'tvly-FAKE' });
		expect(headersOf(call)['X-API-Key']).toBe('kb-FAKE');
	});

	test('blank or whitespace KEENABLE_API_KEY is keyless', async () => {
		process.env.KEENABLE_API_KEY = '   ';
		const call = await run(base);
		expect(call.url).toBe('https://api.keenable.ai/v1/search/public');
		expect(headersOf(call)['X-API-Key']).toBeUndefined();
	});

	test('freshness capability flag: Keenable and SpecStream opt out', () => {
		expect(new KeenableProvider().supportsFreshness).toBe(false);
		expect(new SpecStreamProvider('k').supportsFreshness).toBe(false);
		expect(new TavilyProvider('k').supportsFreshness).toBeUndefined();
		expect(new BraveProvider('k').supportsFreshness).toBeUndefined();
	});
});
