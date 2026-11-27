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
	/**
	 * Probe the promoted path with lstat (does NOT follow the final component).
	 * FB-210 — only 'missing' (ENOENT) authorizes the idempotent-success path;
	 * 'error' (any non-ENOENT inspection failure) and 'other' (non-regular
	 * file) must refuse the revoke.
	 */
	lstatTarget: async (
		filePath: string,
	): Promise<
		| { kind: 'file' }
		| { kind: 'symlink' }
		| { kind: 'other' }
		| { kind: 'missing' }
		| { kind: 'error'; code?: string }
	> => {
		try {
			const st = await fsp.lstat(filePath);
			if (st.isSymbolicLink()) return { kind: 'symlink' };
			if (st.isFile()) return { kind: 'file' };
			return { kind: 'other' };
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT') return { kind: 'missing' };
			return { kind: 'error', code };
		}
	},
	retireSkillFile: async (
		filePath: string,
		options?: { expectedDigest?: string | null },
	): Promise<boolean> => {
		const { unlink } = await import('node:fs/promises');
		// Identity guard AT the destructive step (#3951 AC6): the caller's
		// earlier digest verification can be stale by the time the unlink
		// lands (a concurrent revoke can vacate the slug and a different
		// approved candidate can be promoted into it through the normal
		// exclusive-create path). When an expected digest is supplied, the
		// bounded read + hash happens immediately before the unlink and a
		// mismatch refuses the removal — the replacement file stays in place.
		// The success-path result contract is unchanged (true = removed,
		// false = was-missing/ENOENT); the refusal is a typed error, so
		// existing boolean wrappers keep compiling and forwarding wrappers
		// let it propagate. The residual hash→unlink gap inside this helper
		// remains honestly non-atomic (same stance as the in-code comment at
		// the call site — narrowed, not eliminated).
		if (typeof options?.expectedDigest === 'string') {
			// FB-210 semantics: only a MISSING file skips the digest check —
			// and under the guard, absence is TERMINAL (round-3 review): an
			// absent observation must not authorize a later unlink, because a
			// replacement created after the probe would be deleted unverified.
			// The idempotent false is returned directly; true stays reserved
			// for a verified removal.
			const probe = await _internals.lstatTarget(filePath);
			if (probe.kind === 'file') {
				const guard = await readTargetBounded(
					filePath,
					PROMOTED_ARTIFACT_MAX_BYTES,
				);
				if (!guard.ok) {
					throw new SkillFileDigestMismatchError(
						`Refusing to remove the promoted skill file at ${filePath}: it could not be read for the pre-removal identity check (${guard.reason}). File left in place; candidate left at its recorded verdict.`,
						{ observed: `<${guard.reason}>`, expected: options.expectedDigest },
					);
				}
				const digest = computeArtifactDigest(guard.content);
				if (digest !== options.expectedDigest) {
					throw new SkillFileDigestMismatchError(
						`Refusing to remove the promoted skill file at ${filePath}: its content no longer matches the recorded promoted digest (a replacement may have been promoted into the vacated slug). File left in place; candidate left at its recorded verdict.`,
						{ observed: digest, expected: options.expectedDigest },
					);
				}
			} else if (probe.kind === 'missing') {
				return false;
			} else {
				throw new SkillFileDigestMismatchError(
					`Refusing to remove the promoted skill file at ${filePath}: the pre-removal identity check found ${probe.kind === 'error' ? `an inspection error (${probe.code ?? 'unknown'})` : `a ${probe.kind}`} instead of a regular file. File left in place; candidate left at its recorded verdict.`,
					{ observed: `<${probe.kind}>`, expected: options.expectedDigest },
				);
			}
		}
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

/**
 * Typed refusal thrown by the identity-guarded unlink (#3951 AC6). Throwing
 * (rather than returning a result union) keeps `_internals.retireSkillFile`'s
 * `Promise<boolean>` contract intact for every existing caller and test
 * double, while letting seam wrappers forward the refusal untouched.
 */
export class SkillFileDigestMismatchError extends Error {
	readonly observedDigest: string;
	readonly expectedDigest: string;
	constructor(
		message: string,
		digests: { observed: string; expected: string },
	) {
		super(message);
		this.name = 'SkillFileDigestMismatchError';
		this.observedDigest = digests.observed;
		this.expectedDigest = digests.expected;
	}
}

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

/** Result of the single bounded fd-based verification read (RP-003). */
type BoundedRead =
	| { ok: true; content: string }
	| { ok: false; reason: 'oversize' | 'unreadable' };

/**
 * RP-003 — read the verification target through ONE file handle: open once,
 * fstat the handle, read at most limit+1 bytes, and refuse anything longer.
 * Reading the cap+1 byte detects a file that grew between the fstat and the
 * read (the old stat-then-readFile pair could read an unbounded file in that
 * window). The handle is always closed in finally.
 */
async function readTargetBounded(
	filePath: string,
	limit: number,
): Promise<BoundedRead> {
	let handle: fsp.FileHandle;
	try {
		handle = await fsp.open(filePath, 'r');
	} catch {
		return { ok: false, reason: 'unreadable' };
	}
	try {
		const st = await handle.stat();
		if (st.size > limit) return { ok: false, reason: 'oversize' };
		const buffer = Buffer.alloc(limit + 1);
		let offset = 0;
		while (offset <= limit) {
			const remaining = limit + 1 - offset;
			const { bytesRead } = await handle.read(
				buffer,
				offset,
				Math.min(65_536, remaining),
				offset,
			);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		if (offset > limit) return { ok: false, reason: 'oversize' };
		return { ok: true, content: buffer.toString('utf-8', 0, offset) };
	} catch {
		return { ok: false, reason: 'unreadable' };
	} finally {
		await handle.close();
	}
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
			'Revoke a previously promoted external skill. Resolves the structured promotion identity (target_path + promoted_content_hash) from the candidate record, refuses targets outside .opencode/skills/generated/ or whose final path component is a symlink, retires the SKILL.md, and stamps the candidate as revoked. Structured promotion records (with promoted_content_hash) are hash-verified before the unlink; legacy records without a structured hash are containment-checked only. Returns a disabled message when external_skills.curation_enabled is false.',
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

				// Target inspection (F-003/FB-210). lstat does NOT follow the
				// final component, so a symlink sitting at the promoted path is
				// detected directly; only ENOENT authorizes the idempotent
				// "missing file" success — any other inspection error or a
				// non-regular file refuses the revoke (no unlink, verdict
				// unchanged).
				const targetProbe = await _internals.lstatTarget(lexicalTarget);
				if (targetProbe.kind === 'symlink') {
					return JSON.stringify({
						success: false,
						error: `Refusing to revoke: promotion target is a symlink (${lexicalTarget}). File and candidate left unchanged.`,
					});
				}
				if (targetProbe.kind === 'other') {
					return JSON.stringify({
						success: false,
						error: `Refusing to revoke: promotion target is not a regular file (${lexicalTarget}). File and candidate left unchanged.`,
					});
				}
				if (targetProbe.kind === 'error') {
					return JSON.stringify({
						success: false,
						error: `Refusing to revoke: promotion target could not be inspected (${targetProbe.code ?? 'unknown error'}). File and candidate left unchanged.`,
					});
				}
				const fileExists = targetProbe.kind === 'file';

				if (fileExists) {
					const realRoot = await fsp
						.realpath(rootLexical)
						.catch(() => rootLexical);
					let canonicalTarget: string;
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
						const read = await readTargetBounded(
							lexicalTarget,
							PROMOTED_ARTIFACT_MAX_BYTES,
						);
						if (!read.ok && read.reason === 'oversize') {
							return JSON.stringify({
								success: false,
								error: `Refusing to revoke: promotion target exceeds the ${PROMOTED_ARTIFACT_MAX_BYTES}-byte verification bound`,
							});
						}
						if (!read.ok) {
							return JSON.stringify({
								success: false,
								error:
									'Failed to revoke candidate: promotion target is unreadable',
							});
						}
						const digest = computeArtifactDigest(read.content);
						if (digest !== recordedHash) {
							return JSON.stringify({
								success: false,
								error:
									'Refusing to revoke: the file at the structured target does not match the recorded promoted content hash (possible post-approval modification). File left in place; candidate left promoted.',
							});
						}
					}
				}

				// Unlink the LEXICAL promoted path (MSP-001), not its
				// canonicalized form: the final component is not a symlink
				// (refused above) and canonical containment passed, so the
				// lexical path names exactly the verified file.
				//
				// RESIDUAL WINDOW, honestly stated: the verify→unlink gap is
				// NOT atomic. A writer that swaps the file between the digest
				// check above and this unlink deletes the replacement. We do
				// not claim atomicity we cannot provide on any supported
				// platform; the generated-skill root is assumed single-writer
				// during a revoke.
				// Identity-guarded removal (#3951 AC6): pass the SAME recorded
				// digest verified above so the guard inside retireSkillFile can
				// refuse when the file at the lexical path is no longer the
				// verified bytes (delayed-revoke/replacement interleaving).
				// A refusal returns BEFORE any record mutation — no revoked
				// audit entry is written for a file we did not remove.
				const skillFileRemoved = await _internals.retireSkillFile(
					lexicalTarget,
					{ expectedDigest: recordedHash },
				);

				// Build audit record
				const timestamp = _internals.getTimestamp();
				const historyEntry = {
					verdict: 'revoked' as const,
					timestamp,
					actor: 'user',
					reason: `Revoked: ${reason}. Skill file removed.`,
				};

				// Update candidate: set verdict to revoked and append history.
				// Partial-failure contract (#3951): the destructive unlink has
				// already happened, so an update failure here must surface an
				// honest partial state (file removed, record still promoted)
				// with a re-run remedy — never a silent loss and never a
				// blanket "failed" that hides what DID happen.
				let updated: ExternalSkillCandidate | null;
				try {
					updated = await store.update(candidateId, {
						evaluation_verdict: 'revoked',
						evaluation_history: [historyEntry],
					});
				} catch (updateErr) {
					const updateMessage =
						updateErr instanceof Error ? updateErr.message : String(updateErr);
					return JSON.stringify({
						success: false,
						candidate_id: candidateId,
						// Round-3 review: report the OBSERVED removal outcome,
						// not an unconditional true — a refused/missing removal
						// that also fails its record update is a refusal state,
						// not a removed-file state.
						skill_file_removed: skillFileRemoved,
						error: `Skill file removal outcome: ${skillFileRemoved ? 'removed' : 'not removed (absent or refused)'}; the candidate record update failed: ${updateMessage}. Re-run revoke to complete the record update (the file removal is idempotent).`,
					});
				}
				if (updated === null) {
					// Round-3 review: the record vanished mid-revoke (concurrent
					// delete won). The file outcome stands; there is no record
					// left to stamp — report it honestly instead of
					// dereferencing null through the generic failure handler.
					return JSON.stringify({
						success: false,
						candidate_id: candidateId,
						skill_file_removed: skillFileRemoved,
						error: `Skill file removal outcome: ${skillFileRemoved ? 'removed' : 'not removed (absent or refused)'}; the candidate record no longer exists (concurrent deletion?) — no audit record to update.`,
					});
				}

				return JSON.stringify({
					success: true,
					candidate_id: updated.id,
					evaluation_verdict: 'revoked',
					skill_file_removed: skillFileRemoved,
				});
			} catch (err) {
				// Dedicated refusal branch for the identity-guarded unlink
				// (#3951 D4): the typed error's own message is the actionable
				// refusal (file left in place, candidate left at its recorded
				// verdict, no revoked audit entry written) — surfacing it under
				// a generic "Failed to revoke" prefix would mislabel a
				// deliberate refusal as an operational failure.
				if (err instanceof SkillFileDigestMismatchError) {
					return JSON.stringify({
						success: false,
						candidate_id: candidateId,
						error: err.message,
					});
				}
				const message = err instanceof Error ? err.message : 'Unknown error';
				return JSON.stringify({
					success: false,
					error: `Failed to revoke candidate: ${message}`,
				});
			}
		},
	});
