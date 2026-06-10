/**
 * external_skill_delete — Delete an external skill candidate from the quarantine store.
 *
 * Removes a candidate by ID.  If the candidate was previously promoted, the
 * promoted skill in `.opencode/skills/generated/` is NOT affected — it must be
 * separately retired or revoked.  Returns a disabled message when
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

export const external_skill_delete: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Delete an external skill candidate from the quarantine store. If the candidate was promoted, the promoted skill in .opencode/skills/generated/ remains unless separately retired or revoked. Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			candidate_id: z
				.string()
				.min(1)
				.describe('The UUID of the candidate to delete'),
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

			// Create store and delete
			const store = createExternalSkillStore(directory, {
				max_candidates: config.max_candidates,
			});

			try {
				const deleted = await store.delete(candidateId);

				if (!deleted) {
					return JSON.stringify({
						success: false,
						error: 'Candidate not found',
					});
				}

				return JSON.stringify({
					success: true,
					candidate_id: candidateId,
					deleted: true,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to delete candidate: ${message}`,
				});
			}
		},
	});
