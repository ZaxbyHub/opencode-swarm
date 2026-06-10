/**
 * Tests for max_results resolution in src/tools/web-search.ts
 *
 * Verifies:
 * 1. When max_results arg is omitted, uses generalConfig.maxSourcesPerMember
 * 2. When max_results is provided, it overrides the config default
 * 3. Values above MAX_RESULTS_HARD_CAP (10) are clamped
 * 4. The config default of 5 is respected when council.general is enabled
 *
 * Mocks provider and config to isolate the resolution logic.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import { loadPluginConfig } from '../../../src/config/loader.js';
import type { GeneralCouncilConfig } from '../../../src/council/general-council-types.js';
import {
	createWebSearchProvider,
	WebSearchConfigError,
	WebSearchError,
} from '../../../src/council/web-search-provider.js';

// Mock the provider to capture the maxResults argument
const mockSearch = vi.fn<
	[string, number],
	Promise<Array<{ title: string; url: string; snippet: string }>>
>();
const mockCreateProvider = vi.fn(() => ({
	search: mockSearch,
}));

// Mock modules BEFORE importing web-search
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
	council?: { general?: GeneralCouncilConfig };
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

describe('max_results resolution', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		globalThis.fetch = ORIGINAL_FETCH;
		mockSearch.mockResolvedValue([
			{ title: 'Result', url: 'https://example.com', snippet: 'Snippet' },
		]);
	});

	afterEach(() => {
		globalThis.fetch = ORIGINAL_FETCH;
	});

	test('1. When max_results arg is omitted, uses generalConfig.maxSourcesPerMember', async () => {
		// maxSourcesPerMember = 7
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 7 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test' }, '/tmp/test');

		// Provider should be called with maxSourcesPerMember (7), not hard cap (10)
		expect(mockSearch).toHaveBeenCalledWith('test', 7, {
			freshness: undefined,
		});
	});

	test('2. When max_results is provided, it overrides the config default', async () => {
		// config has maxSourcesPerMember = 5, but arg provides max_results = 3
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 5 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test', max_results: 3 }, '/tmp/test');

		// Provider should be called with the arg value (3), not config (5)
		expect(mockSearch).toHaveBeenCalledWith('test', 3, {
			freshness: undefined,
		});
	});

	test('3. Values above MAX_RESULTS_HARD_CAP (10) are clamped', async () => {
		// config has maxSourcesPerMember = 5, arg provides max_results = 20 (above hard cap of 10)
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 5 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test', max_results: 20 }, '/tmp/test');

		// Should be clamped to MAX_RESULTS_HARD_CAP (10)
		expect(mockSearch).toHaveBeenCalledWith('test', 10, {
			freshness: undefined,
		});
	});

	test('3b. Config value above hard cap is also clamped', async () => {
		// config has maxSourcesPerMember = 15 (above hard cap of 10), no arg
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 15 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test' }, '/tmp/test');

		// Should be clamped to MAX_RESULTS_HARD_CAP (10)
		expect(mockSearch).toHaveBeenCalledWith('test', 10, {
			freshness: undefined,
		});
	});

	test('4. Config default of 5 is respected when council.general is enabled', async () => {
		// Default maxSourcesPerMember = 5 (from GENERAL_COUNCIL_DEFAULTS)
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 5 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test' }, '/tmp/test');

		// Should use config default of 5
		expect(mockSearch).toHaveBeenCalledWith('test', 5, {
			freshness: undefined,
		});
	});

	test('Edge: max_results of 1 is respected (below hard cap)', async () => {
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 5 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test', max_results: 1 }, '/tmp/test');

		expect(mockSearch).toHaveBeenCalledWith('test', 1, {
			freshness: undefined,
		});
	});

	test('Edge: max_results of 10 equals hard cap (boundary)', async () => {
		mockLoadPluginConfig.mockReturnValue(
			buildConfig({ maxSourcesPerMember: 5 }),
		);
		mockCreateProvider.mockReturnValue({ search: mockSearch });

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		await wrapped.execute({ query: 'test', max_results: 10 }, '/tmp/test');

		expect(mockSearch).toHaveBeenCalledWith('test', 10, {
			freshness: undefined,
		});
	});

	test('Error path: missing API key returns structured failure', async () => {
		mockLoadPluginConfig.mockReturnValue(buildConfig());
		mockCreateProvider.mockImplementation(() => {
			throw new WebSearchConfigError();
		});

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		const result = await wrapped.execute({ query: 'test' }, '/tmp/test');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('missing_api_key');
	});

	test('Error path: search failure returns structured failure', async () => {
		mockLoadPluginConfig.mockReturnValue(buildConfig());
		mockCreateProvider.mockReturnValue({
			search: async () => {
				throw new WebSearchError();
			},
		});

		const { web_search } = await import('../../../src/tools/web-search.js');
		const wrapped = web_search as unknown as {
			execute: (args: unknown, dir: string) => Promise<string>;
		};

		const result = await wrapped.execute({ query: 'test' }, '/tmp/test');
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.reason).toBe('search_failed');
	});
});
