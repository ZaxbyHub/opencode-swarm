/**
 * web_search tool — owned by the architect for MODE: COUNCIL pre-search.
 *
 * Thin wrapper around `src/council/web-search-provider.ts`. Returns structured
 * results on success and structured errors on failure (never throws). Config-
 * gated on `council.general.enabled`. The provider itself surfaces missing-key
 * configuration via WebSearchConfigError, which this tool maps to a structured
 * `success: false` response.
 *
 * Hard cap on max_results = 10 (clamped silently). Default sourced from council.general.maxSourcesPerMember.
 */

import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import {
	createWebSearchProvider,
	WebSearchConfigError,
	WebSearchError,
} from '../council/web-search-provider';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const MAX_RESULTS_HARD_CAP = 10;

const ArgsSchema = z.object({
	query: z.string().min(1).max(500),
	max_results: z.number().int().min(1).max(20).optional(),
	working_directory: z.string().optional(),
});

interface WebSearchOk {
	success: true;
	query: string;
	totalResults: number;
	results: Array<{ title: string; url: string; snippet: string }>;
}

interface WebSearchFail {
	success: false;
	reason: string;
	message: string;
}

export const web_search: ReturnType<typeof tool> = createSwarmTool({
	description:
		'External web search for architect-driven council research. Returns titled results with snippets and URLs. ' +
		'Used by the architect in MODE: COUNCIL to gather a RESEARCH CONTEXT before dispatching council agents. ' +
		'Requires council.general.enabled and a configured search API key (Tavily or Brave). max_results is capped at 10 with default from council.general.maxSourcesPerMember.',
	args: {
		query: z
			.string()
			.min(1)
			.max(500)
			.describe('Search query string (1–500 characters).'),
		max_results: z
			.number()
			.int()
			.min(1)
			.max(20)
			.optional()
			.describe(
				`Number of results to request (1–20). Hard-capped at ${MAX_RESULTS_HARD_CAP}. Defaults to council.general.maxSourcesPerMember.`,
			),
		working_directory: z
			.string()
			.optional()
			.describe('Project root for config resolution. Optional.'),
	},
	execute: async (args, directory) => {
		const parsed = ArgsSchema.safeParse(args);
		if (!parsed.success) {
			const fail: WebSearchFail = {
				success: false,
				reason: 'invalid_args',
				message: parsed.error.issues
					.map((i) => `${i.path.join('.')}: ${i.message}`)
					.join('; '),
			};
			return JSON.stringify(fail, null, 2);
		}

		const dirResult = resolveWorkingDirectory(
			parsed.data.working_directory,
			directory,
		);
		if (!dirResult.success) {
			const fail: WebSearchFail = {
				success: false,
				reason: 'invalid_working_directory',
				message: dirResult.message,
			};
			return JSON.stringify(fail, null, 2);
		}

		const config = loadPluginConfig(dirResult.directory);
		const generalConfig = config.council?.general;
		if (!generalConfig || generalConfig.enabled !== true) {
			const fail: WebSearchFail = {
				success: false,
				reason: 'council_general_disabled',
				message:
					'web_search is disabled — set council.general.enabled: true in opencode-swarm.json.',
			};
			return JSON.stringify(fail, null, 2);
		}

		const requested =
			parsed.data.max_results ?? generalConfig.maxSourcesPerMember;
		const maxResults = Math.min(requested, MAX_RESULTS_HARD_CAP);

		let provider: ReturnType<typeof createWebSearchProvider>;
		try {
			provider = createWebSearchProvider(generalConfig);
		} catch (err) {
			const fail: WebSearchFail = {
				success: false,
				reason:
					err instanceof WebSearchConfigError
						? 'missing_api_key'
						: 'provider_init_failed',
				message: err instanceof Error ? err.message : String(err),
			};
			return JSON.stringify(fail, null, 2);
		}

		try {
			const results = await provider.search(parsed.data.query, maxResults);
			const ok: WebSearchOk = {
				success: true,
				query: parsed.data.query,
				totalResults: results.length,
				results: results.map(({ title, url, snippet }) => ({
					title,
					url,
					snippet,
				})),
			};
			return JSON.stringify(ok, null, 2);
		} catch (err) {
			const fail: WebSearchFail = {
				success: false,
				reason: err instanceof WebSearchError ? 'search_failed' : 'unknown',
				message: err instanceof Error ? err.message : String(err),
			};
			return JSON.stringify(fail, null, 2);
		}
	},
});
