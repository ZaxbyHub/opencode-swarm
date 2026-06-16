/**
 * external_skill_list — List external skill candidates in the quarantine store.
 *
 * Read-only tool that returns candidate summaries filtered by evaluation verdict,
 * source type, or date range.  Returns a disabled message when
 * external_skills.curation_enabled is false.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type {
	ExternalSkillCandidateEvaluationVerdict,
	ExternalSkillsConfig,
} from '../config/schema.js';
import type { ExternalSkillListFilter } from '../services/external-skill-store.js';
import { createExternalSkillStore } from '../services/external-skill-store.js';
import { createSwarmTool } from './create-tool.js';

// ---------------------------------------------------------------------------
// DI Seam — _internals
// ---------------------------------------------------------------------------

export const _internals = {
	loadConfig: (directory: string): ExternalSkillsConfig | undefined => {
		const pluginConfig = loadPluginConfig(directory);
		return pluginConfig.external_skills;
	},
};

// ---------------------------------------------------------------------------
// Disabled message (shared across all external-skill stubs)
// ---------------------------------------------------------------------------

const DISABLED_MESSAGE =
	'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const external_skill_list: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'List external skill candidates in the quarantine store. Filter by verdict, source_type, or since date. Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			verdict: z
				.enum([
					'pending',
					'in_review',
					'quarantined',
					'passed',
					'rejected',
					'promoted',
					'revoked',
				])
				.optional()
				.describe(
					'Filter by evaluation verdict: pending, in_review, quarantined, passed, rejected, promoted, revoked',
				),
			source_type: z
				.enum(['github', 'url', 'collection', 'manual_import'])
				.optional()
				.describe(
					'Filter by source type: github, url, collection, manual_import',
				),
			since: z
				.string()
				.optional()
				.describe(
					'ISO datetime string — only return candidates fetched at or after this time',
				),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let verdict: unknown;
			let sourceType: unknown;
			let since: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					verdict = obj.verdict;
					sourceType = obj.source_type;
					since = obj.since;
				}
			} catch {
				// Malicious getter threw
			}

			// Resolve config — if curation is not enabled, return disabled message
			let config: ExternalSkillsConfig | undefined;
			try {
				config = _internals.loadConfig(directory);
			} catch {
				return JSON.stringify({
					success: false,
					error: 'Failed to load plugin configuration',
				});
			}

			if (!config || !config.curation_enabled) {
				return DISABLED_MESSAGE;
			}

			// Create store
			const store = createExternalSkillStore(directory, {
				max_candidates: config.max_candidates,
			});

			// Build filter from args
			const filter: ExternalSkillListFilter = {};

			if (typeof verdict === 'string') {
				filter.verdict = verdict as ExternalSkillCandidateEvaluationVerdict;
			}
			if (typeof sourceType === 'string') {
				filter.source_type = sourceType;
			}
			if (typeof since === 'string') {
				filter.since = since;
			}

			// List candidates
			try {
				const candidates = await store.list(filter);

				// Return summary fields for each candidate
				const summaries = candidates.map((c) => ({
					id: c.id,
					source_url: c.source_url,
					source_type: c.source_type,
					publisher: c.publisher,
					skill_name: c.skill_name,
					evaluation_verdict: c.evaluation_verdict,
					fetched_at: c.fetched_at,
					risk_flags_count: c.risk_flags.length,
				}));

				return JSON.stringify(summaries);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to list candidates: ${message}`,
				});
			}
		},
	});
