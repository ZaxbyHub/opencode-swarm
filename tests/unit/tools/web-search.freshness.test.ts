/**
 * Freshness reporting in src/tools/web-search.ts.
 *
 * Providers that report `supportsFreshness === false` (Keenable) must not get
 * a freshness filter and the tool must not report freshness as applied.
 * Tavily/Brave (flag undefined) keep applying and echoing it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { loadPluginConfig } from '../../../src/config/loader.js';
import type { GeneralCouncilConfig } from '../../../src/council/general-council-types.js';
import {
	createWebSearchProvider,
	WebSearchConfigError,
	WebSearchError,
} from '../../../src/council/web-search-provider.js';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const mockSearch = vi.fn<
	[string, number, { freshness?: string }?],
	Promise<Array<{ title: string; url: string; snippet: string }>>
>();
const mockCreateProvider = vi.fn(() => ({ search: mockSearch }));

vi.mock('../../../src/council/web-search-provider.js', () => ({
	createWebSearchProvider: mockCreateProvider,
	WebSearchConfigError,
	WebSearchError,
}));

vi.mock('../../../src/config/loader.js', () => ({
	loadPluginConfig: vi.fn(),
}));

const ORIGINAL_FETCH = globalThis.fetch;
const mockLoadPluginConfig = loadPluginConfig as ReturnType<typeof vi.fn>;

function buildConfig(overrides: Partial<GeneralCouncilConfig> = {}): {
	council: { general: GeneralCouncilConfig };
} {
	return {
		council: {
			general: {
				enabled: true,
				searchProvider: 'tavily',
				members: [],
				presets: {},
				deliberate: true,
				moderator: false,
				maxSourcesPerMember: 5,
				...overrides,
			},
		},
	};
}

async function runTool(
	args: Record<string, unknown>,
	directory: string,
): Promise<Record<string, unknown>> {
	const { web_search } = await import('../../../src/tools/web-search.js');
	const wrapped = web_search as unknown as {
		execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
	};
	return JSON.parse(await wrapped.execute(args, { directory }));
}

describe('web_search freshness capability', () => {
	let sandboxDir: string;

	beforeEach(() => {
		sandboxDir = canonicalMkdtemp('web-search-freshness-');
		vi.clearAllMocks();
		globalThis.fetch = ORIGINAL_FETCH;
		mockLoadPluginConfig.mockReturnValue(buildConfig());
		mockSearch.mockResolvedValue([
			{ title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
		]);
	});

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
		removeTreeWithRetry(sandboxDir);
	});

	test('supported provider (flag undefined): freshness is passed and reported', async () => {
		mockCreateProvider.mockReturnValue({ search: mockSearch });
		const out = await runTool({ query: 'test', freshness: 'week' }, sandboxDir);
		expect(mockSearch).toHaveBeenCalledWith('test', 5, { freshness: 'week' });
		expect(out.success).toBe(true);
		expect(out.freshness).toBe('week');
	});

	test('supportsFreshness === true behaves like undefined', async () => {
		mockCreateProvider.mockReturnValue({
			search: mockSearch,
			supportsFreshness: true,
		} as never);
		const out = await runTool(
			{ query: 'test', freshness: 'month' },
			sandboxDir,
		);
		expect(mockSearch).toHaveBeenCalledWith('test', 5, { freshness: 'month' });
		expect(out.freshness).toBe('month');
	});

	test('unsupported provider: no freshness requested and none reported', async () => {
		mockCreateProvider.mockReturnValue({
			search: mockSearch,
			supportsFreshness: false,
		} as never);
		const out = await runTool({ query: 'test', freshness: 'week' }, sandboxDir);
		expect(mockSearch).toHaveBeenCalledWith('test', 5, {
			freshness: undefined,
		});
		expect(out.success).toBe(true);
		expect('freshness' in out).toBe(false);
	});

	test('unsupported provider still strips stale years from the query', async () => {
		mockCreateProvider.mockReturnValue({
			search: mockSearch,
			supportsFreshness: false,
		} as never);
		const out = await runTool(
			{ query: 'latest bun release 2023', freshness: 'auto' },
			sandboxDir,
		);
		expect(out.originalQuery).toBe('latest bun release 2023');
		expect(out.query).not.toContain('2023');
		expect(out.removedStaleYears).toEqual(['2023']);
		expect('freshness' in out).toBe(false);
	});
});
