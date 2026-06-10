/**
 * external_skill_reject — Reject an external skill candidate after evaluation.
 *
 * Marks a candidate as rejected with a user-provided reason.  Records the
 * state transition in evaluation_history with timestamp, actor, and reason.
 * Returns a disabled message when external_skills.curation_enabled is false.
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

export const external_skill_reject: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Reject an external skill candidate after evaluation. Records the state transition in evaluation_history with timestamp, actor, and reason. Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			candidate_id: z
				.string()
				.min(1)
				.describe('The UUID of the candidate to reject'),
			reason: z.string().min(1).describe('Human-readable reason for rejection'),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let candidateId: unknown;
			let reason: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					candidateId = obj.candidate_id;
					reason = obj.reason;
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

			// Validate required reason
			if (typeof reason !== 'string' || reason.trim().length === 0) {
				return JSON.stringify({
					success: false,
					error: 'reason is required and must be a non-empty string',
				});
			}

			// Create store
			const store = createExternalSkillStore(directory, {
				max_candidates: config.max_candidates,
			});

			// Get candidate by ID — verify it exists
			try {
				const candidate = await store.get(candidateId);

				if (!candidate) {
					return JSON.stringify({
						success: false,
						error: 'Candidate not found',
					});
				}

				// Build the evaluation history entry with user actor and reason
				const historyEntry = {
					verdict: 'rejected' as const,
					timestamp: new Date().toISOString(),
					actor: 'user',
					reason: reason,
				};

				// Update candidate: set verdict to rejected and append history
				const updated = await store.update(candidateId, {
					evaluation_verdict: 'rejected',
					evaluation_history: [historyEntry],
				});

				return JSON.stringify({
					success: true,
					candidate_id: updated!.id,
					evaluation_verdict: 'rejected',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to reject candidate: ${message}`,
				});
			}
		},
	});
