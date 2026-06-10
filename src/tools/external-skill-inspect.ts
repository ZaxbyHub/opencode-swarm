/**
 * external_skill_inspect — Inspect a specific external skill candidate by ID.
 *
 * Read-only tool that returns the full candidate record including provenance,
 * skill_body, and evaluation_history.  Returns a disabled message when
 * external_skills.curation_enabled is false.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type { ExternalSkillsConfig } from '../config/schema.js';
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

export const external_skill_inspect: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Inspect a specific external skill candidate by ID. Returns the full candidate record including provenance, skill_body, and evaluation_history. Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			candidate_id: z
				.string()
				.min(1)
				.describe('The UUID of the candidate to inspect'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let candidateId: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					candidateId = obj.candidate_id;
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

			// Validate required candidate_id
			if (typeof candidateId !== 'string' || candidateId.trim().length === 0) {
				return JSON.stringify({
					success: false,
					error: 'candidate_id is required and must be a non-empty string',
				});
			}

			// Create store
			const store = createExternalSkillStore(directory, {
				max_candidates: config.max_candidates,
			});

			// Get candidate by ID
			try {
				const candidate = await store.get(candidateId);

				if (!candidate) {
					return JSON.stringify({
						success: false,
						error: 'Candidate not found',
					});
				}

				return JSON.stringify(candidate);
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to inspect candidate: ${message}`,
				});
			}
		},
	});
