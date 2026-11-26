/**
 * Web search provider abstraction for the General Council Mode.
 *
 * Four concrete providers (Tavily, Brave, Keenable, SpecStream) plus a factory that
 * selects one based on `GeneralCouncilConfig.searchProvider`. Pure HTTP
 * layer — no tool wiring or prompt rendering. Uses the native `fetch` API
 * (Bun-compatible); no external HTTP libraries. Keenable is opt-in and
 * works without a key. SpecStream is opt-in and needs SPECSTREAM_API_KEY.
 *
 * Errors are surfaced as typed exceptions:
 *   - WebSearchConfigError — missing API key (factory)
 *   - WebSearchError       — HTTP failure (4xx/5xx, network, timeout)
 * Malformed but successful responses produce an empty result array, never throw.
 */

import { withTimeoutSignal } from '../utils/timeout.js';
import type {
	GeneralCouncilConfig,
	WebSearchResult,
} from './general-council-types.js';
import type { SearchFreshness } from './search-query-policy.js';

export class WebSearchError extends Error {
	constructor(
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'WebSearchError';
	}
}

export class WebSearchConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WebSearchConfigError';
	}
}

export interface WebSearchProvider {
	/**
	 * Whether the provider honors `WebSearchOptions.freshness`. Undefined means
	 * supported (Tavily, Brave); `false` means the provider sends no time-range
	 * filter, so callers must not report freshness as applied.
	 */
	readonly supportsFreshness?: boolean;
	search(
		query: string,
		maxResults: number,
		options?: WebSearchOptions,
	): Promise<WebSearchResult[]>;
}

export interface WebSearchOptions {
	freshness?: SearchFreshness;
}

interface TavilyResponse {
	results?: Array<{
		title?: string;
		url?: string;
		content?: string;
	}>;
}

interface BraveResponse {
	web?: {
		results?: Array<{
			title?: string;
			url?: string;
			description?: string;
		}>;
	};
}

/**
 * Bounded, abortable deadline for every provider fetch (issue #2476 AC6).
 * A provider that accepts the connection but never responds must turn into a
 * typed `WebSearchError` here, not an indefinitely pending council pass.
 * AbortSignal.timeout is available on every supported runtime (Bun >= 1.3,
 * Node >= 17.3; this repo pins Node >= 22.13).
 */
const SEARCH_TIMEOUT_MS = 6_000;

export class TavilyProvider implements WebSearchProvider {
	constructor(private readonly apiKey: string) {}

	async search(
		query: string,
		maxResults: number,
		options: WebSearchOptions = {},
	): Promise<WebSearchResult[]> {
		const requestBody: Record<string, unknown> = {
			api_key: this.apiKey,
			query,
			max_results: maxResults,
			search_depth: 'advanced',
		};
		if (options.freshness) {
			requestBody.time_range = options.freshness;
		}

		let response: Response;
		// #2476 AC6: bounded abortable fetch. withTimeoutSignal (the
		// repo-sanctioned native-timeout replacement, #1964/#2103) trips a
		// manual AbortController at the deadline and races the operation.
		const timeoutError = new WebSearchError(
			`Tavily search timed out after ${SEARCH_TIMEOUT_MS}ms`,
		);
		try {
			response = await withTimeoutSignal(
				(signal) =>
					fetch('https://api.tavily.com/search', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(requestBody),
						signal,
					}),
				SEARCH_TIMEOUT_MS,
				timeoutError,
			);
		} catch (err) {
			// PRR-008: surface the deadline miss itself, not a "network error"
			// wrapper that mislabels it for consumers printing err.message.
			if (err === timeoutError) throw err;
			throw new WebSearchError(
				`Tavily network error for query "${query}"`,
				err,
			);
		}

		if (!response.ok) {
			throw new WebSearchError(
				`Tavily HTTP ${response.status} for query "${query}"`,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (err) {
			throw new WebSearchError('Tavily returned non-JSON response', err);
		}

		const results = (body as TavilyResponse | null)?.results;
		if (!Array.isArray(results)) {
			// Malformed but successful response — return empty rather than throw
			return [];
		}

		return results
			.filter(
				(r): r is { title: string; url: string; content: string } =>
					typeof r?.title === 'string' &&
					typeof r?.url === 'string' &&
					typeof r?.content === 'string',
			)
			.map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.content,
				query,
			}));
	}
}

export class BraveProvider implements WebSearchProvider {
	constructor(private readonly apiKey: string) {}

	async search(
		query: string,
		maxResults: number,
		options: WebSearchOptions = {},
	): Promise<WebSearchResult[]> {
		const url = new URL('https://api.search.brave.com/res/v1/web/search');
		url.searchParams.set('q', query);
		url.searchParams.set('count', String(maxResults));
		const freshness = toBraveFreshness(options.freshness);
		if (freshness) {
			url.searchParams.set('freshness', freshness);
		}

		let response: Response;
		// #2476 AC6 — same sanctioned timeout wrapper as Tavily above.
		const braveTimeoutError = new WebSearchError(
			`Brave search timed out after ${SEARCH_TIMEOUT_MS}ms`,
		);
		try {
			response = await withTimeoutSignal(
				(signal) =>
					fetch(url.toString(), {
						method: 'GET',
						headers: {
							'X-Subscription-Token': this.apiKey,
							Accept: 'application/json',
						},
						signal,
					}),
				SEARCH_TIMEOUT_MS,
				braveTimeoutError,
			);
		} catch (err) {
			if (err === braveTimeoutError) throw err;
			throw new WebSearchError(`Brave network error for query "${query}"`, err);
		}

		if (!response.ok) {
			throw new WebSearchError(
				`Brave HTTP ${response.status} for query "${query}"`,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (err) {
			throw new WebSearchError('Brave returned non-JSON response', err);
		}

		const results = (body as BraveResponse | null)?.web?.results;
		if (!Array.isArray(results)) {
			return [];
		}

		return results
			.filter(
				(r): r is { title: string; url: string; description: string } =>
					typeof r?.title === 'string' &&
					typeof r?.url === 'string' &&
					typeof r?.description === 'string',
			)
			.map((r) => ({
				title: r.title,
				url: r.url,
				snippet: r.description,
				query,
			}));
	}
}

function toBraveFreshness(freshness?: SearchFreshness): string | undefined {
	switch (freshness) {
		case 'day':
			return 'pd';
		case 'week':
			return 'pw';
		case 'month':
			return 'pm';
		case 'year':
			return 'py';
		default:
			return undefined;
	}
}

interface KeenableResponse {
	results?: Array<{
		title?: string;
		url?: string;
		snippet?: string;
		description?: string;
	}>;
}

export class KeenableProvider implements WebSearchProvider {
	readonly supportsFreshness = false;

	constructor(private readonly apiKey?: string) {}

	async search(
		query: string,
		maxResults: number,
		_options: WebSearchOptions = {},
	): Promise<WebSearchResult[]> {
		const keyed = typeof this.apiKey === 'string' && this.apiKey.length > 0;
		const url = keyed
			? 'https://api.keenable.ai/v1/search'
			: 'https://api.keenable.ai/v1/search/public';
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json',
			'X-Keenable-Title': 'opencode-swarm',
		};
		if (keyed) headers['X-API-Key'] = this.apiKey as string;

		let response: Response;
		const timeoutError = new WebSearchError(
			`Keenable search timed out after ${SEARCH_TIMEOUT_MS}ms`,
		);
		try {
			response = await withTimeoutSignal(
				(signal) =>
					fetch(url, {
						method: 'POST',
						headers,
						body: JSON.stringify({ query, max_results: maxResults }),
						signal,
						redirect: 'error',
					}),
				SEARCH_TIMEOUT_MS,
				timeoutError,
			);
		} catch (err) {
			if (err === timeoutError) throw err;
			if (
				err instanceof Error &&
				((err as { code?: unknown }).code === 'UnexpectedRedirect' ||
					/redirect/i.test(err.message))
			) {
				throw new WebSearchError(
					'Keenable request was redirected (refused)',
					err,
				);
			}
			throw new WebSearchError(
				`Keenable network error for query "${query}"`,
				err,
			);
		}

		if (!response.ok) {
			throw new WebSearchError(
				`Keenable HTTP ${response.status} for query "${query}"`,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (err) {
			throw new WebSearchError('Keenable returned non-JSON response', err);
		}

		const results = (body as KeenableResponse | null)?.results;
		if (!Array.isArray(results)) {
			return [];
		}

		const mapped: WebSearchResult[] = [];
		for (const r of results) {
			if (typeof r?.title !== 'string' || typeof r?.url !== 'string') continue;
			const snippet =
				(typeof r.snippet === 'string' && r.snippet) ||
				(typeof r.description === 'string' && r.description) ||
				'';
			// Parity with Tavily/Brave: results without a snippet are dropped.
			if (snippet === '') continue;
			mapped.push({ title: r.title, url: r.url, snippet, query });
		}
		return mapped;
	}
}

interface SpecStreamResponse {
	data?: {
		sources?: Array<{
			title?: string;
			url?: string;
			snippet?: string;
		}>;
	};
}

/**
 * SpecStream Search API (`GET /v1/web-search`). Results are the ranked
 * `data.sources`; `data.answer`, which the API adds for some factual
 * questions, is not mapped so every provider returns the same shape.
 */
export class SpecStreamProvider implements WebSearchProvider {
	readonly supportsFreshness = false;

	constructor(private readonly apiKey: string) {}

	async search(
		query: string,
		maxResults: number,
		_options: WebSearchOptions = {},
	): Promise<WebSearchResult[]> {
		const url = new URL('https://api.specstream.ai/v1/web-search');
		url.searchParams.set('q', query);
		url.searchParams.set('num', String(maxResults));

		let response: Response;
		const timeoutError = new WebSearchError(
			`SpecStream search timed out after ${SEARCH_TIMEOUT_MS}ms`,
		);
		try {
			response = await withTimeoutSignal(
				(signal) =>
					fetch(url.toString(), {
						method: 'GET',
						headers: {
							Authorization: `Bearer ${this.apiKey}`,
							Accept: 'application/json',
						},
						signal,
						// The Authorization header must never follow a redirect off
						// api.specstream.ai (same policy as Keenable).
						redirect: 'error',
					}),
				SEARCH_TIMEOUT_MS,
				timeoutError,
			);
		} catch (err) {
			if (err === timeoutError) throw err;
			if (
				err instanceof Error &&
				((err as { code?: unknown }).code === 'UnexpectedRedirect' ||
					/redirect/i.test(err.message))
			) {
				throw new WebSearchError(
					'SpecStream request was redirected (refused)',
					err,
				);
			}
			throw new WebSearchError(
				`SpecStream network error for query "${query}"`,
				err,
			);
		}

		if (!response.ok) {
			throw new WebSearchError(
				`SpecStream HTTP ${response.status} for query "${query}"`,
			);
		}

		let body: unknown;
		try {
			body = await response.json();
		} catch (err) {
			throw new WebSearchError('SpecStream returned non-JSON response', err);
		}

		const sources = (body as SpecStreamResponse | null)?.data?.sources;
		if (!Array.isArray(sources)) {
			return [];
		}

		const mapped: WebSearchResult[] = [];
		for (const s of sources) {
			if (typeof s?.title !== 'string' || typeof s?.url !== 'string') continue;
			// Parity with Tavily/Brave/Keenable: results without a snippet are dropped.
			if (typeof s.snippet !== 'string' || s.snippet === '') continue;
			mapped.push({ title: s.title, url: s.url, snippet: s.snippet, query });
		}
		return mapped;
	}
}

/**
 * Resolve the API key from config first, then env var fallback (Tavily and
 * Brave). Keenable is env-only (see below). Returns undefined if no key is
 * set so callers can decide how to surface that.
 */
function resolveApiKey(
	provider: 'tavily' | 'brave' | 'keenable' | 'specstream',
	configKey?: string,
): string | undefined {
	// Credential scoping: `council.general.searchApiKey` is a single shared
	// field, so a key a user set for Tavily/Brave must never be forwarded to
	// Keenable (e.g. when a project config only flips searchProvider). Keenable
	// reads KEENABLE_API_KEY only; blank/whitespace means keyless.
	if (provider === 'keenable') {
		const fromEnv = process.env.KEENABLE_API_KEY?.trim();
		return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
	}
	// SpecStream follows the same scoping as Keenable (#3762): its key comes
	// only from SPECSTREAM_API_KEY, so a Tavily/Brave searchApiKey is never
	// sent to it as a Bearer token.
	if (provider === 'specstream') {
		const fromEnv = process.env.SPECSTREAM_API_KEY?.trim();
		return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
	}
	if (configKey && configKey.length > 0) {
		return configKey;
	}
	const envName =
		provider === 'tavily' ? 'TAVILY_API_KEY' : 'BRAVE_SEARCH_API_KEY';
	const fromEnv = process.env[envName];
	return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function createWebSearchProvider(
	config: GeneralCouncilConfig,
): WebSearchProvider {
	if (config.searchProvider === 'keenable') {
		return new KeenableProvider(resolveApiKey('keenable'));
	}
	if (config.searchProvider === 'specstream') {
		const key = resolveApiKey('specstream');
		if (!key) {
			throw new WebSearchConfigError(
				'No API key for search provider "specstream". Export SPECSTREAM_API_KEY ' +
					'(council.general.searchApiKey is not used for SpecStream). Keys: https://specstream.ai/workspace/keys',
			);
		}
		return new SpecStreamProvider(key);
	}
	const apiKey = resolveApiKey(config.searchProvider, config.searchApiKey);
	if (!apiKey) {
		const envName =
			config.searchProvider === 'tavily'
				? 'TAVILY_API_KEY'
				: 'BRAVE_SEARCH_API_KEY';
		throw new WebSearchConfigError(
			`No API key for search provider "${config.searchProvider}". Set ` +
				`council.general.searchApiKey in the resolved config (global ~/.config/opencode/opencode-swarm.json, project .opencode/opencode-swarm.json override) or export ${envName}.`,
		);
	}
	switch (config.searchProvider) {
		case 'tavily':
			return new TavilyProvider(apiKey);
		case 'brave':
			return new BraveProvider(apiKey);
	}
}
