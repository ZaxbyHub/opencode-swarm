/**
 * web_search tool — owned by the architect for MODE: COUNCIL pre-search and
 * by SME/skill_improver for opt-in external research.
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
import { applySearchQueryPolicy } from '../council/search-query-policy';
import {
	createWebSearchProvider,
	WebSearchConfigError,
	WebSearchError,
} from '../council/web-search-provider';
import { writeEvidenceDocuments } from '../evidence/documents';
import { scanExternalContent } from '../services/external-content-scanner';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

const MAX_RESULTS_HARD_CAP = 10;

const ArgsSchema = z.object({
	query: z.string().min(1).max(500),
	max_results: z.number().int().min(1).max(20).optional(),
	freshness: z
		.enum(['auto', 'none', 'day', 'week', 'month', 'year'])
		.default('auto'),
	working_directory: z.string().optional(),
});

interface WebSearchOk {
	success: true;
	query: string;
	originalQuery: string;
	temporalIntent: 'current' | 'historical' | 'unspecified';
	freshness?: 'day' | 'week' | 'month' | 'year';
	removedStaleYears: string[];
	totalResults: number;
	results: Array<{
		title: string;
		url: string;
		snippet: string;
		evidenceRef?: string;
		threatLevel?: 'error' | 'warning' | 'none';
	}>;
	evidence: {
		stored: boolean;
		path?: string;
		refs: string[];
		error?: string;
	};
}

interface WebSearchFail {
	success: false;
	reason: string;
	message: string;
}

export const web_search: ReturnType<typeof tool> = createSwarmTool({
	description:
		'External web search for architect-driven council research, SME domain research, and skill-improver research. Returns titled results with snippets and URLs. ' +
		'Used by the architect in MODE: COUNCIL to gather a RESEARCH CONTEXT before dispatching council agents and by SME to evaluate external skill/source candidates. ' +
		'Normalizes current-intent queries, strips trailing stale cutoff years, and applies provider freshness filters by default. ' +
		'Requires council.general.enabled and a configured search API key (Tavily or Brave) in the resolved config: global ~/.config/opencode/opencode-swarm.json, then project .opencode/opencode-swarm.json overrides. max_results is capped at 10 with default from council.general.maxSourcesPerMember.',
	args: {
		query: z
			.string()
			.min(1)
			.max(500)
			.describe('Search query string (1–500 characters).'),
		freshness: z
			.enum(['auto', 'none', 'day', 'week', 'month', 'year'])
			.optional()
			.describe(
				'Optional freshness filter. Query normalization always runs; "auto" infers provider freshness from current/recency terms, while "none" disables provider freshness filtering.',
			),
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
					'web_search is disabled - set council.general.enabled: true in the resolved config: global ~/.config/opencode/opencode-swarm.json or project .opencode/opencode-swarm.json.',
			};
			return JSON.stringify(fail, null, 2);
		}

		const requested =
			parsed.data.max_results ?? generalConfig.maxSourcesPerMember;
		const maxResults = Math.min(requested, MAX_RESULTS_HARD_CAP);
		const policy = applySearchQueryPolicy(parsed.data.query);
		const requestedFreshness = parsed.data.freshness ?? 'auto';
		const freshness =
			requestedFreshness === 'auto'
				? policy.freshness
				: requestedFreshness === 'none'
					? undefined
					: requestedFreshness;

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
			const results = await provider.search(policy.query, maxResults, {
				freshness,
			});
			const evidence = await captureSearchEvidence(
				dirResult.directory,
				policy.query,
				results,
			);

			// Scan each result's title and snippet for threats
			const scannedResults: WebSearchOk['results'] = results.map(
				({ title, url, snippet }) => {
					const titleScan = scanExternalContent(title, { trustLevel: 'low' });
					const snippetScan = scanExternalContent(snippet, {
						trustLevel: 'low',
					});

					const threatLevel: 'error' | 'warning' | 'none' =
						titleScan.threatLevel === 'error' ||
						snippetScan.threatLevel === 'error'
							? 'error'
							: titleScan.threatLevel === 'warning' ||
									snippetScan.threatLevel === 'warning'
								? 'warning'
								: 'none';

					return {
						title: titleScan.clean ? title : titleScan.neutralized,
						url,
						snippet: snippetScan.clean ? snippet : snippetScan.neutralized,
						evidenceRef: evidence.refByUrl.get(url),
						threatLevel,
					};
				},
			);

			const ok: WebSearchOk = {
				success: true,
				query: policy.query,
				originalQuery: policy.originalQuery,
				temporalIntent: policy.temporalIntent,
				freshness,
				removedStaleYears: policy.removedStaleYears,
				totalResults: results.length,
				results: scannedResults,
				evidence: {
					stored: evidence.stored,
					path: evidence.path,
					refs: evidence.refs,
					error: evidence.error,
				},
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

async function captureSearchEvidence(
	directory: string,
	query: string,
	results: Array<{ title: string; url: string; snippet: string }>,
): Promise<{
	stored: boolean;
	path?: string;
	refs: string[];
	refByUrl: Map<string, string>;
	error?: string;
}> {
	try {
		const written = await _internals.writeEvidenceDocuments(
			directory,
			results.map((result) => ({
				sourceType: 'web_search',
				query,
				title: result.title,
				url: result.url,
				snippet: result.snippet,
				createdBy: 'web_search',
			})),
		);
		const refByUrl = new Map<string, string>();
		for (const record of written.records) {
			if (record.url) refByUrl.set(record.url, record.ref);
		}
		return {
			stored: written.records.length > 0,
			path: written.path,
			refs: written.refs,
			refByUrl,
		};
	} catch (err) {
		return {
			stored: false,
			refs: [],
			refByUrl: new Map(),
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export const _internals: {
	writeEvidenceDocuments: typeof writeEvidenceDocuments;
} = {
	writeEvidenceDocuments,
};
