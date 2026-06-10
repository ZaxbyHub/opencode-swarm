/**
 * external_skill_revoke — Revoke a previously promoted external skill.
 *
 * Atomically retires the SKILL.md from `.opencode/skills/generated/<slug>/`
 * and stamps the candidate with evaluation_verdict: 'revoked'.  The candidate
 * stays in quarantine for forensic audit.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type {
	ExternalSkillCandidate,
	ExternalSkillsConfig,
} from '../config/schema.js';
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
	getTimestamp: (): string => new Date().toISOString(),
	retireSkillFile: async (filePath: string): Promise<boolean> => {
		const { unlink } = await import('node:fs/promises');
		try {
			await unlink(filePath);
			return true;
		} catch (err: unknown) {
			const error = err as NodeJS.ErrnoException;
			if (error?.code === 'ENOENT') return false;
			throw err;
		}
	},
};

// ---------------------------------------------------------------------------
// Disabled message (shared across all external-skill stubs)
// ---------------------------------------------------------------------------

const DISABLED_MESSAGE =
	'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slug validation — matches the sanitization output of external-skill-promote. */
const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Extract the slug from a promoted candidate's evaluation_history.
 *
 * Looks for the 'promoted' entry whose `reason` contains the target path
 * pattern `.opencode/skills/generated/<slug>/SKILL.md` and returns the slug.
 *
 * The extracted slug is validated against SAFE_SLUG_RE to prevent path
 * traversal (e.g. backslashes or directory traversal characters in a
 * corrupted history entry).
 *
 * Returns `null` if no promotion entry or slug is found, or if the slug
 * fails validation.
 */
function extractSlugFromHistory(
	history: ExternalSkillCandidate['evaluation_history'],
): string | null {
	for (const entry of history) {
		if (entry.verdict === 'promoted' && entry.reason) {
			const match = entry.reason.match(
				/\.opencode\/skills\/generated\/([^/]+)\/SKILL\.md/,
			);
			if (match) {
				const slug = match[1];
				return SAFE_SLUG_RE.test(slug) ? slug : null;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const external_skill_revoke: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Revoke a previously promoted external skill. Retires the SKILL.md from .opencode/skills/generated/ and stamps the candidate as revoked. Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			candidate_id: z
				.string()
				.min(1)
				.describe('The UUID of the promoted candidate to revoke'),
			reason: z
				.string()
				.min(1)
				.describe('Human-readable reason for revocation'),
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

			try {
				// Get candidate by ID — verify it exists
				const candidate = await store.get(candidateId);

				if (!candidate) {
					return JSON.stringify({
						success: false,
						error: 'Candidate not found',
					});
				}

				// Only promoted candidates can be revoked
				if (candidate.evaluation_verdict !== 'promoted') {
					return JSON.stringify({
						success: false,
						error: 'Only promoted candidates can be revoked',
					});
				}

				// Extract the slug from the promotion history entry
				const slug = extractSlugFromHistory(candidate.evaluation_history);

				if (!slug) {
					return JSON.stringify({
						success: false,
						error:
							'Cannot revoke: unable to determine the skill slug from promotion history. The candidate record may be corrupted. Manually remove the skill file from .opencode/skills/generated/ if needed.',
					});
				}

				const skillPath = path.join(
					directory,
					'.opencode',
					'skills',
					'generated',
					slug,
					'SKILL.md',
				);
				const skillFileRemoved = await _internals.retireSkillFile(skillPath);

				// Build audit record
				const timestamp = _internals.getTimestamp();
				const historyEntry = {
					verdict: 'revoked' as const,
					timestamp,
					actor: 'user',
					reason: `Revoked: ${reason}. Skill file removed.`,
				};

				// Update candidate: set verdict to revoked and append history
				const updated = await store.update(candidateId, {
					evaluation_verdict: 'revoked',
					evaluation_history: [historyEntry],
				});

				return JSON.stringify({
					success: true,
					candidate_id: updated!.id,
					evaluation_verdict: 'revoked',
					skill_file_removed: skillFileRemoved,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to revoke candidate: ${message}`,
				});
			}
		},
	});
