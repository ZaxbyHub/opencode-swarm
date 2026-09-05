import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import http from 'node:http';
import {
	BraveProvider,
	TavilyProvider,
	WebSearchError,
} from '../../../src/council/web-search-provider';

/**
 * Issue #2476 AC6: both provider fetches must carry a bounded abortable
 * signal so a provider that accepts the connection but never responds
 * rejects with a typed WebSearchError instead of hanging the council pass.
 */
describe('web-search provider fetch timeout (#2476 AC6)', () => {
	let server: http.Server;
	let port: number;
	const realFetch = globalThis.fetch;

	beforeAll(() => {
		server = http.createServer(() => {
			// Never respond: headers, body, nothing.
		});
		server.listen(0, '127.0.0.1');
		port = (server.address() as { port: number }).port;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
			realFetch(`http://127.0.0.1:${port}/hang`, init)) as typeof fetch;
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		server.close();
	});

	// Per-test budget 9s: SEARCH_TIMEOUT_MS is 6s, so the abort must land
	// between bun's 5s default budget and 9s — this budget is also the guard
	// that fails the test if the signal is ever removed (a per-test budget
	// overrides CI's --timeout 120000).
	test('TavilyProvider rejects with WebSearchError within 8s', async () => {
		const provider = new TavilyProvider('test-key');
		const startedAt = performance.now();
		// PRR-008: the deadline miss itself is surfaced (message says "timed
		// out"), not wrapped as a generic "network error".
		await expect(provider.search('query', 1)).rejects.toThrow(
			/Tavily search timed out after 6000ms/,
		);
		expect(performance.now() - startedAt).toBeLessThan(8_000);
	}, 9_000);

	test('BraveProvider rejects with WebSearchError within 8s', async () => {
		const provider = new BraveProvider('test-key');
		const startedAt = performance.now();
		await expect(provider.search('query', 1)).rejects.toThrow(
			/Brave search timed out after 6000ms/,
		);
		expect(performance.now() - startedAt).toBeLessThan(8_000);
	}, 9_000);

	test('a fast successful response still parses normally', async () => {
		// Restore real fetch routed to a server that answers instantly, to
		// prove the signal does not abort healthy requests.
		const fast = http.createServer((req, res) => {
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ results: [] }));
		});
		fast.listen(0, '127.0.0.1');
		const fastPort = (fast.address() as { port: number }).port;
		globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
			realFetch(`http://127.0.0.1:${fastPort}/ok`, init)) as typeof fetch;
		try {
			const provider = new TavilyProvider('test-key');
			const results = await provider.search('query', 1);
			expect(results).toEqual([]);
		} finally {
			globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
				realFetch(`http://127.0.0.1:${port}/hang`, init)) as typeof fetch;
			fast.close();
		}
	});
});
