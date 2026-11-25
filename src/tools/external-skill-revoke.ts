/**
 * external_skill_revoke — Revoke a previously promoted external skill.
 *
 * Atomically retires the SKILL.md from `.opencode/skills/generated/<slug>/`
 * and stamps the candidate with evaluation_verdict: 'revoked'.  The candidate
 * stays in quarantine for forensic audit.
 *
 * Uses an `_internals` DI seam for testability — no `mock.module` leakage.
 */

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader.js';
import type {
	ExternalSkillCandidate,
	ExternalSkillsConfig,
} from '../config/schema.js';
import {
	computeArtifactDigest,
	PROMOTED_ARTIFACT_MAX_BYTES,
} from '../services/external-skill-identity.js';
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

/** SHA-256 shape accepted for structured promotion hashes. */
const HEX64_RE = /^[a-f0-9]{64}$/;

/** Windows paths compare case-insensitively. */
const IS_WIN = process.platform === 'win32';

function pathKey(p: string): string {
	return IS_WIN ? p.toLowerCase() : p;
}

/** Strictly-inside containment (a target EQUAL to the root is not inside). */
function isStrictlyInside(root: string, candidate: string): boolean {
	if (pathKey(candidate) === pathKey(root)) return false;
	return pathKey(candidate).startsWith(`${pathKey(root)}${path.sep}`);
}

/** Lexical generated-skill root every revoke target must live under. */
function generatedSkillRoot(directory: string): string {
	return path.resolve(directory, '.opencode', 'skills', 'generated');
}

interface StructuredPromotionTarget {
	targetPath: string;
	promotedContentHash: string;
}

/**
 * Resolve the STRUCTURED promotion identity (#3822 K2): the newest
 * 'promoted' history entry that CARRIES both `target_path` and
 * `promoted_content_hash`. Automatic history entries lacking them are not
 * valid targets — they never describe where the artifact landed.
 */
function findStructuredPromotionEntry(
	history: ExternalSkillCandidate['evaluation_history'],
): StructuredPromotionTarget | null {
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (entry.verdict !== 'promoted') continue;
		const targetPath =
			typeof entry.target_path === 'string' ? entry.target_path.trim() : '';
		if (!targetPath) continue;
		if (
			typeof entry.promoted_content_hash !== 'string' ||
			!HEX64_RE.test(entry.promoted_content_hash)
		) {
			continue;
		}
		return {
			targetPath,
			promotedContentHash: entry.promoted_content_hash,
		};
	}
	return null;
}

/**
 * Extract the slug from a promoted candidate's evaluation_history.
 *
 * LEGACY FALLBACK (#3822 K2): only used for candidates promoted before the
 * structured `target_path` + `promoted_content_hash` fields existed. The
 * containment checks apply to this path exactly as they do to the structured
 * target.
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
			'Revoke a previously promoted external skill. Resolves the structured promotion identity (target_path + promoted_content_hash) from the candidate record, refuses targets outside .opencode/skills/generated/ or files that no longer match the recorded hash, retires the SKILL.md, and stamps the candidate as revoked. Returns a disabled message when external_skills.curation_enabled is false.',
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

				// Resolve the deletion target from the STRUCTURED identity
				// (#3822 K2) — the newest 'promoted' history entry carrying
				// `target_path` + `promoted_content_hash`. Legacy candidates
				// without structured fields keep the prose-slug derivation,
				// still containment-checked.
				const structured = findStructuredPromotionEntry(
					candidate.evaluation_history,
				);

				let lexicalTarget: string;
				let recordedHash: string | null = null;
				if (structured) {
					lexicalTarget = path.resolve(directory, structured.targetPath);
					recordedHash = structured.promotedContentHash;
				} else {
					const slug = extractSlugFromHistory(candidate.evaluation_history);
					if (!slug) {
						return JSON.stringify({
							success: false,
							error:
								'Cannot revoke: unable to determine the skill slug from promotion history. The candidate record may be corrupted. Manually remove the skill file from .opencode/skills/generated/ if needed.',
						});
					}
					lexicalTarget = path.resolve(
						directory,
						'.opencode',
						'skills',
						'generated',
						slug,
						'SKILL.md',
					);
				}

				// Containment (lexical): outside absolute paths and traversal are
				// rejected even when the file is missing.
				const rootLexical = generatedSkillRoot(directory);
				if (!isStrictlyInside(rootLexical, lexicalTarget)) {
					return JSON.stringify({
						success: false,
						error: `Refusing to revoke: promotion target escapes the generated-skill root (${lexicalTarget})`,
					});
				}

				// Containment (canonical) + hash binding. A missing file is an
				// idempotent success (nothing to remove).
				let canonicalTarget = lexicalTarget;
				let fileExists = false;
				try {
					const st = await fsp.stat(lexicalTarget);
					fileExists = st.isFile();
				} catch {
					fileExists = false;
				}

				if (fileExists) {
					const realRoot = await fsp
						.realpath(rootLexical)
						.catch(() => rootLexical);
					try {
						canonicalTarget = await fsp.realpath(lexicalTarget);
					} catch {
						return JSON.stringify({
							success: false,
							error: `Failed to revoke candidate: cannot resolve promotion target ${lexicalTarget}`,
						});
					}
					// Symlink/junction escapes resolve outside the generated root.
					if (!isStrictlyInside(realRoot, canonicalTarget)) {
						return JSON.stringify({
							success: false,
							error: `Refusing to revoke: promotion target resolves outside the generated-skill root (${canonicalTarget})`,
						});
					}
					// Refuse to unlink bytes that no longer match the recorded
					// promotion hash — the artifact may have been modified after
					// approval; the file AND the candidate verdict stay unchanged.
					if (recordedHash !== null) {
						let content: string;
						try {
							const st = await fsp.stat(canonicalTarget);
							if (st.size > PROMOTED_ARTIFACT_MAX_BYTES) {
								return JSON.stringify({
									success: false,
									error: `Refusing to revoke: promotion target exceeds the ${PROMOTED_ARTIFACT_MAX_BYTES}-byte verification bound`,
								});
							}
							content = await fsp.readFile(canonicalTarget, 'utf-8');
						} catch {
							return JSON.stringify({
								success: false,
								error:
									'Failed to revoke candidate: promotion target is unreadable',
							});
						}
						const digest = computeArtifactDigest(content);
						if (digest !== recordedHash) {
							return JSON.stringify({
								success: false,
								error:
									'Refusing to revoke: the file at the structured target does not match the recorded promoted content hash (possible post-approval modification). File left in place; candidate left promoted.',
							});
						}
					}
				}

				const skillFileRemoved =
					await _internals.retireSkillFile(canonicalTarget);

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
