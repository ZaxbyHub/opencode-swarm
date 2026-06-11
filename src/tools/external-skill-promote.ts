/**
 * external_skill_promote — Promote a validated external skill candidate to an
 * active generated skill.
 *
 * Re-runs all three validation gates (TOCTOU re-validation).  Requires explicit
 * user approval (`approver='user'`).  Writes SKILL.md to
 * `.opencode/skills/generated/<slug>/` with provenance frontmatter.  Stamps the
 * candidate as promoted and creates an audit record.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type {
	ExternalSkillCandidate,
	ExternalSkillsConfig,
} from '../config/schema.js';
import { createExternalSkillStore } from '../services/external-skill-store.js';
import { evaluateCandidate } from '../services/external-skill-validator.js';
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
	fileExists: async (filePath: string): Promise<boolean> => {
		try {
			await fs.access(filePath, fs.constants.F_OK);
			return true;
		} catch {
			return false;
		}
	},
	writeSkillFile: async (filePath: string, content: string): Promise<void> => {
		await fs.mkdir(path.dirname(filePath), { recursive: true });
		const handle = await fs.open(filePath, 'wx'); // exclusive — fails with EEXIST if file exists
		try {
			await handle.writeFile(content, 'utf-8');
		} finally {
			await handle.close();
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

/**
 * Sanitize a user-supplied slug for use as a directory name.
 *
 * - Lowercase
 * - Replace non-alphanumeric characters with '-'
 * - Trim leading/trailing dashes
 * - Collapse consecutive dashes into one
 * - Maximum 64 characters
 *
 * Returns `null` if the result is empty.
 */
function sanitizeSlug(raw: string): string | null {
	const slug = raw
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
	return slug.length > 0 ? slug : null;
}

/**
 * Build SKILL.md content with YAML provenance frontmatter.
 */
function buildSkillMarkdown(
	candidate: ExternalSkillCandidate,
	slug: string,
	timestamp: string,
): string {
	return [
		'---',
		`promoted_from: external-skill-candidate`,
		`slug: ${slug}`,
		`candidate_id: ${candidate.id}`,
		`source_url: ${candidate.source_url}`,
		`source_type: ${candidate.source_type}`,
		`publisher: ${candidate.publisher}`,
		`sha256: ${candidate.sha256}`,
		`promoted_at: ${timestamp}`,
		`promoted_by: user`,
		'---',
		'',
		candidate.skill_body,
	].join('\n');
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const external_skill_promote: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Promote a validated external skill candidate to an active generated skill. Re-runs all validation gates (TOCTOU re-validation). Requires explicit user approval (approver="user"). Returns a disabled message when external_skills.curation_enabled is false.',
		args: {
			candidate_id: z
				.string()
				.min(1)
				.describe('The UUID of the candidate to promote'),
			slug: z
				.string()
				.min(1)
				.describe(
					'Target directory name under .opencode/skills/generated/ (will be sanitized)',
				),
			approver: z
				.string()
				.min(1)
				.describe(
					'Who approved the promotion — must be "user" (no agent/auto approval)',
				),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let candidateId: unknown;
			let slug: unknown;
			let approver: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					candidateId = obj.candidate_id;
					slug = obj.slug;
					approver = obj.approver;
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

			// Validate required slug
			if (typeof slug !== 'string' || slug.trim().length === 0) {
				return JSON.stringify({
					success: false,
					error: 'slug is required and must be a non-empty string',
				});
			}

			// Validate required approver
			if (typeof approver !== 'string' || approver.trim().length === 0) {
				return JSON.stringify({
					success: false,
					error: 'approver is required and must be a non-empty string',
				});
			}

			// Only user approval is allowed — no agent/auto approval
			if (approver !== 'user') {
				return JSON.stringify({
					success: false,
					error: 'Only user approval is allowed',
				});
			}

			// Sanitize slug
			const sanitizedSlug = sanitizeSlug(slug);
			if (sanitizedSlug === null) {
				return JSON.stringify({
					success: false,
					error: 'slug is empty after sanitization — provide a valid slug',
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

				// Only 'passed' or 'quarantined' candidates can be promoted
				if (
					candidate.evaluation_verdict !== 'passed' &&
					candidate.evaluation_verdict !== 'quarantined'
				) {
					return JSON.stringify({
						success: false,
						error: 'Candidate must be evaluated before promotion',
					});
				}

				// TOCTOU re-validation — re-run all three gates
				const revalidation = evaluateCandidate(candidate, {
					trust_level: 'low',
					ttl_days: config.ttl_days,
				});

				if (revalidation.overall_verdict === 'quarantined') {
					return JSON.stringify({
						success: false,
						error: 'Re-validation failed — candidate no longer passes gates',
					});
				}

				// Build target path
				const targetDir = path.join(
					directory,
					'.opencode',
					'skills',
					'generated',
					sanitizedSlug,
				);
				const targetPath = path.join(targetDir, 'SKILL.md');
				const timestamp = _internals.getTimestamp();

				// Check for slug collision — reject if SKILL.md already exists
				const alreadyExists = await _internals.fileExists(targetPath);
				if (alreadyExists) {
					return JSON.stringify({
						success: false,
						error: `Skill '${sanitizedSlug}' already exists at ${targetPath}. Use a different slug or retire the existing skill first.`,
					});
				}

				// Build and write SKILL.md with provenance frontmatter
				const skillMarkdown = buildSkillMarkdown(
					candidate,
					sanitizedSlug,
					timestamp,
				);
				try {
					await _internals.writeSkillFile(targetPath, skillMarkdown);
				} catch (writeErr: unknown) {
					const writeError = writeErr as NodeJS.ErrnoException;
					if (writeError?.code === 'EEXIST') {
						return JSON.stringify({
							success: false,
							error: `Skill '${sanitizedSlug}' already exists at ${targetPath}. Use a different slug or retire the existing skill first.`,
						});
					}
					throw writeErr;
				}

				// Build audit record — includes gate results, risk assessment,
				// provenance snapshot, and original validation context per FR-006.
				const promotedContentHash = createHash('sha256')
					.update(skillMarkdown)
					.digest('hex');

				// Retrieve the last pre-promotion evaluation history entry for
				// original_validation context, falling back to the verdict string.
				const prePromotionHistory = candidate.evaluation_history;
				const lastPrePromotionEntry =
					prePromotionHistory.length > 0
						? prePromotionHistory[prePromotionHistory.length - 1]
						: undefined;
				const originalEvaluation = lastPrePromotionEntry
					? {
							verdict: lastPrePromotionEntry.verdict,
							timestamp: lastPrePromotionEntry.timestamp,
							actor: lastPrePromotionEntry.actor,
							gate_results: lastPrePromotionEntry.gate_results ?? undefined,
							risk_assessment:
								lastPrePromotionEntry.risk_assessment ?? undefined,
						}
					: {
							original_verdict: candidate.evaluation_verdict,
							note: 'Original gate results not available from history',
						};

				const auditEntry = {
					verdict: 'promoted' as const,
					timestamp,
					actor: 'user',
					candidate_id: candidateId,
					reason: `Promoted to .opencode/skills/generated/${sanitizedSlug}/SKILL.md — re-validation passed`,
					original_verdict: candidate.evaluation_verdict,
					gate_results: revalidation.gate_results.map((gr) => ({
						gate: gr.gate,
						verdict: gr.verdict,
					})),
					risk_assessment: {
						total_flags: revalidation.risk_flags?.length ?? 0,
						findings:
							revalidation.all_findings?.map((f) => ({
								severity: f.severity,
								category: f.pattern,
							})) ?? [],
					},
					provenance_snapshot: {
						sha256: candidate.sha256,
						source_url: candidate.source_url,
						publisher: candidate.publisher,
						fetched_at: candidate.fetched_at,
					},
					target_path: targetPath,
					promoted_content_hash: promotedContentHash,
					original_evaluation: originalEvaluation,
				};

				// Update candidate: set verdict to promoted and append history
				await store.update(candidateId, {
					evaluation_verdict: 'promoted',
					evaluation_history: [auditEntry],
				});

				return JSON.stringify({
					success: true,
					candidate_id: candidateId,
					slug: sanitizedSlug,
					target_path: targetPath,
					evaluation_verdict: 'promoted',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to promote candidate: ${message}`,
				});
			}
		},
	});
