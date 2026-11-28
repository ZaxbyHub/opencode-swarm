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
import { BUNDLED_PROJECT_SKILLS } from '../config/bundled-skills.js';
import { loadPluginConfig } from '../config/loader.js';
import type {
	ExternalSkillCandidate,
	ExternalSkillsConfig,
} from '../config/schema.js';
import { SKILL_FRONTMATTER_READ_BYTES } from '../hooks/skill-scoring.js';
import {
	computeArtifactDigest,
	MAX_PROMOTION_RECORD_FILES,
	PROMOTED_ARTIFACT_MAX_BYTES,
	PROMOTION_RECORD_MAX_BYTES,
} from '../services/external-skill-identity.js';
import {
	applyCandidatePatch,
	createExternalSkillStore,
} from '../services/external-skill-store.js';
import { evaluateCandidate } from '../services/external-skill-validator.js';
import { createSwarmTool } from './create-tool.js';

// ---------------------------------------------------------------------------
// DI Seam — _internals
// ---------------------------------------------------------------------------

/** Marker read bound — mirrors the propagation gate's MAX_MARKER_BYTES class. */
const LIFECYCLE_MARKER_MAX_BYTES = 8_192;

/**
 * Pre-write lifecycle-marker predicate for an EMPTIED slug directory (#3951
 * NF-3). Pure read: never mutates the marker, SKILL.md, or the store. The
 * propagation gate refuses a skill whose directory carries a `retired.marker`
 * or `stale.marker` BEFORE digest verification, so promoting into such a
 * directory would produce an artifact the gate can never accept. Marker read
 * anomalies (missing stat, symlink, oversize) fail CLOSED to the refusal with
 * the read reason — a governance signal we cannot read is treated as present.
 */
async function readLifecycleMarkerState(
	slugDir: string,
): Promise<{ blocked: boolean; diagnostic?: string }> {
	const markers: Array<{
		name: 'retired.marker' | 'stale.marker';
		kind: 'retired' | 'stale';
	}> = [
		{ name: 'retired.marker', kind: 'retired' },
		{ name: 'stale.marker', kind: 'stale' },
	];
	const found: Array<{ kind: 'retired' | 'stale'; path: string }> = [];
	for (const marker of markers) {
		const markerPath = path.join(slugDir, marker.name);
		try {
			const st = await fs.lstat(markerPath);
			if (!st.isFile()) {
				return {
					blocked: true,
					diagnostic: `Refusing to promote: lifecycle marker '${marker.name}' at ${markerPath} is not a regular file — resolve the marker state (or promote under a different slug) before promoting into this directory.`,
				};
			}
			if (st.size > LIFECYCLE_MARKER_MAX_BYTES) {
				return {
					blocked: true,
					diagnostic: `Refusing to promote: lifecycle marker '${marker.name}' at ${markerPath} is ${st.size} bytes, above the ${LIFECYCLE_MARKER_MAX_BYTES}-byte marker bound — resolve the marker state (or promote under a different slug) before promoting into this directory.`,
				};
			}
			await fs.readFile(markerPath, 'utf-8'); // readability probe
			found.push({ kind: marker.kind, path: markerPath });
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === 'ENOENT') continue;
			return {
				blocked: true,
				diagnostic: `Refusing to promote: lifecycle marker '${marker.name}' at ${markerPath} could not be read (${code ?? 'unknown error'}) — resolve the marker state (or promote under a different slug) before promoting into this directory.`,
			};
		}
	}
	if (found.length === 0) return { blocked: false };
	const retired = found.find((m) => m.kind === 'retired');
	if (retired) {
		const staleCompanion = found.find((m) => m.kind === 'stale');
		return {
			blocked: true,
			diagnostic: `Refusing to promote: slug directory ${slugDir} was retired and then emptied — the retirement marker ${retired.path} still blocks the propagation gate for any new skill written here. Delete ${retired.path} to unretire the slug${staleCompanion ? ` (and the stale marker ${staleCompanion.path})` : ''}, or promote under a different slug.`,
		};
	}
	const stale = found[0]!;
	return {
		blocked: true,
		diagnostic: `Refusing to promote: slug directory ${slugDir} was marked stale and then emptied — the staleness marker ${stale.path} still blocks the propagation gate for any new skill written here. Delete ${stale.path} (staleness re-evaluates on the next regeneration sweep), or promote under a different slug.`,
	};
}

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
	/**
	 * Number of `*.json` record files in the candidate store (0 when the store
	 * does not exist yet). Any other read failure propagates so promote fails
	 * closed instead of promoting into a store it cannot inspect.
	 */
	countCandidateRecords: async (directory: string): Promise<number> => {
		try {
			const names = await fs.readdir(
				path.join(directory, '.swarm', 'skills', 'candidates'),
			);
			return names.filter((name) => name.endsWith('.json')).length;
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
			throw err;
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
	/**
	 * Read a file; `null` ONLY when it does not exist (ENOENT). Any other read
	 * failure propagates so cleanup never mistakes an unreadable file for an
	 * absent one.
	 */
	readSkillFile: async (filePath: string): Promise<string | null> => {
		try {
			return await fs.readFile(filePath, 'utf-8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
			throw err;
		}
	},
	/**
	 * Unlink a file; an already-missing file (ENOENT) is fine, any other
	 * failure propagates so cleanup never reports a removal that did not
	 * happen. The caller (cleanupOrphanedArtifact) is the one that swallows it.
	 */
	deleteSkillFile: async (filePath: string): Promise<void> => {
		try {
			await fs.unlink(filePath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
			throw err;
		}
	},
};

// ---------------------------------------------------------------------------
// Frontmatter injection guard (FB-106)
// ---------------------------------------------------------------------------

/**
 * Control characters (Unicode Cc: C0, DEL, C1 — includes CR and LF) forbidden
 * in every field interpolated verbatim into the artifact frontmatter. A value
 * carrying a line break can smuggle a forged `content_digest:` line into the
 * frontmatter (the canonical digest replaces only the FIRST such line), which
 * desynchronizes the recorded `promoted_content_hash` from the written bytes
 * and leaves the promoted skill permanently unverifiable (self-DoS).
 */
const CONTROL_CHAR_RE = /\p{Cc}/u;

/** First field name (of the interpolated set) carrying a control character. */
function findControlCharField(
	fields: Array<{ name: string; value: string }>,
): string | null {
	for (const field of fields) {
		if (CONTROL_CHAR_RE.test(field.value)) return field.name;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Disabled message (shared across all external-skill stubs)
// ---------------------------------------------------------------------------

const DISABLED_MESSAGE =
	'External skill curation is not enabled. Set external_skills.curation_enabled to true in your opencode config.';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugs reserved by bundled project skills (#3822 K3) — promoting an external
 * candidate under one of these names would produce a same-name skill in a
 * different root, so the collision is refused the same way the generator
 * path refuses it (skill-generator's RESERVED_ACTIVE_SKILL_SLUGS rule).
 */
const RESERVED_PROMOTION_SLUGS = new Set<string>(BUNDLED_PROJECT_SKILLS);

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
 *
 * The `content_digest` line carries the canonical artifact digest
 * (#3822 K1(a)). It is ADVISORY for humans — the authoritative binding lives
 * in the structured candidate record; the propagation gate recomputes the
 * canonical digest and compares it against the record, never against this
 * line.
 */
function buildSkillMarkdown(
	candidate: ExternalSkillCandidate,
	slug: string,
	timestamp: string,
	contentDigest: string,
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
		`content_digest: ${contentDigest}`,
		`promoted_at: ${timestamp}`,
		`promoted_by: user`,
		`skill_origin: promoted_external`,
		`version: 1`,
		'---',
		'',
		candidate.skill_body,
	].join('\n');
}

/**
 * Ownership-safe best-effort cleanup of a just-written artifact after the
 * candidate-store update failed (FB-107). The artifact is deleted ONLY when
 * its on-disk bytes are BYTE-FOR-BYTE identical to what promote wrote — the
 * comparison is exact string equality, NOT computeArtifactDigest, because
 * the canonical digest deliberately masks the advisory content_digest line
 * VALUE, so a replacement that differs only in that value would be
 * digest-identical yet is not ours and must be preserved. A file replaced by
 * a concurrent writer BEFORE the comparison is never deleted. The
 * compare-then-unlink sequence is not atomic (Node has no compare-and-delete),
 * so a replacement landing in the instant between the comparison and the
 * unlink is a documented residual window of this best-effort path. Failures
 * here are swallowed: the ORIGINAL store error must stay the surfaced error.
 *
 * Returns true only when it is CONFIRMED that no artifact of ours remains
 * (already absent, or deleted without error); false when a different file was
 * preserved or the removal failed, so callers never claim a removal that did
 * not happen.
 */
async function cleanupOrphanedArtifact(
	filePath: string,
	writtenContent: string,
): Promise<boolean> {
	try {
		const current = await _internals.readSkillFile(filePath);
		if (current === null) return true;
		if (current !== writtenContent) {
			// Not our exact bytes anymore — a replacement must be preserved.
			return false;
		}
		await _internals.deleteSkillFile(filePath);
		return true;
	} catch {
		// Best-effort only — never mask the original store.update error.
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const external_skill_promote: ReturnType<typeof createSwarmTool> =
	createSwarmTool({
		description:
			'Promote a validated external skill candidate to an active generated skill. Re-runs all validation gates (TOCTOU re-validation). Requires explicit user approval (approver="user"). Optionally accepts expected_sha256 — the SHA-256 of the reviewed candidate skill_body — and refuses as a stale base when the candidate changed since review. Returns a disabled message when external_skills.curation_enabled is false.',
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
			expected_sha256: z
				.string()
				.optional()
				.describe(
					'Optional SHA-256 (64-char hex) of the candidate skill_body as reviewed — binding promotion to the reviewed bytes; a mismatch refuses with a stale-candidate error',
				),
		},
		execute: async (args: unknown, directory: string): Promise<string> => {
			// Safe args extraction
			let candidateId: unknown;
			let slug: unknown;
			let approver: unknown;
			let expectedSha256: unknown;

			try {
				if (args && typeof args === 'object') {
					const obj = args as Record<string, unknown>;
					candidateId = obj.candidate_id;
					slug = obj.slug;
					approver = obj.approver;
					expectedSha256 = obj.expected_sha256;
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

			// FB-106 — the raw slug is interpolated into the frontmatter, so a
			// control character (CR/LF or any Cc) is refused BEFORE sanitization
			// could mask it. Checked pre-sanitize so 'my\nskill' cannot slip
			// through as 'my-skill' with a hidden injection.
			if (typeof slug === 'string' && CONTROL_CHAR_RE.test(slug)) {
				return JSON.stringify({
					success: false,
					error:
						"Refusing to promote: field 'slug' contains a control character (CR/LF or other Cc) — frontmatter injection risk",
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

			// #3822 K3 — refuse slugs reserved by bundled project skills so an
			// external candidate cannot produce a same-name skill in a
			// different root.
			if (RESERVED_PROMOTION_SLUGS.has(sanitizedSlug)) {
				return JSON.stringify({
					success: false,
					error: `slug "${sanitizedSlug}" is reserved by a bundled project skill — choose a different slug`,
				});
			}

			// Optional expected_sha256 (#3822 ASK-3) — shape check before the
			// candidate is loaded; value comparison happens once the candidate
			// body is in hand.
			if (expectedSha256 !== undefined) {
				if (
					typeof expectedSha256 !== 'string' ||
					!/^[a-f0-9]{64}$/i.test(expectedSha256)
				) {
					return JSON.stringify({
						success: false,
						error: 'expected_sha256 must be a 64-character hex SHA-256 string',
					});
				}
				expectedSha256 = expectedSha256.toLowerCase();
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

				// Stale-base refusal (#3822 ASK-3, approved): when the caller
				// supplies the digest of the bytes they reviewed, promotion is
				// bound to exactly those bytes — a candidate whose skill_body
				// changed since review is refused (the skill-opt
				// --expected-content-hash precedent).
				if (expectedSha256 !== undefined) {
					const bodyHash = createHash('sha256')
						.update(candidate.skill_body)
						.digest('hex');
					if (bodyHash !== expectedSha256) {
						return JSON.stringify({
							success: false,
							error:
								'stale candidate: content changed since review (expected_sha256 mismatch)',
						});
					}
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

				// FB-106 — every candidate field interpolated into the artifact
				// frontmatter is refused when it carries CR/LF or any other
				// control character, BEFORE anything is written. A forged
				// 'content_digest:' line smuggled through a line break would
				// desynchronize the recorded hash from the written bytes.
				const injectedField = findControlCharField([
					{ name: 'publisher', value: candidate.publisher },
					{ name: 'source_url', value: candidate.source_url },
					{ name: 'source_type', value: candidate.source_type },
					{ name: 'candidate_id', value: candidate.id },
					{ name: 'sha256', value: candidate.sha256 },
				]);
				if (injectedField !== null) {
					return JSON.stringify({
						success: false,
						error: `Refusing to promote: field '${injectedField}' contains a control character (CR/LF or other Cc) — frontmatter injection risk`,
					});
				}

				// Build the artifact markdown (no writes yet) and run the
				// structural pre-write checks BEFORE the TOCTOU re-validation:
				// the bound checks must fire even for candidates the gates
				// would quarantine for unrelated reasons, and hashing a large
				// body is cheaper than regex-scanning it twice.
				//
				// #3822 K1: the canonical artifact digest is computed over a
				// draft whose digest line carries a placeholder value —
				// computeArtifactDigest replaces that whole line with a fixed
				// placeholder before hashing, so the draft's value never
				// influences the result. The same canonical digest is stamped
				// into the frontmatter (advisory) and recorded in the
				// structured candidate record (authoritative); the propagation
				// gate recomputes it over the on-disk bytes and fails closed
				// on mismatch.
				const timestamp = _internals.getTimestamp();
				const draftMarkdown = buildSkillMarkdown(
					candidate,
					sanitizedSlug,
					timestamp,
					'pending',
				);
				const promotedContentHash = computeArtifactDigest(draftMarkdown);
				const skillMarkdown = buildSkillMarkdown(
					candidate,
					sanitizedSlug,
					timestamp,
					promotedContentHash,
				);

				// FB-106 — final defense in depth: the digest of the EXACT bytes
				// about to be written must equal the hash that will be recorded.
				// A mismatch means the draft/final pair desynchronized (e.g. an
				// injected digest line the field validation above did not catch);
				// refuse and write NOTHING rather than record unverifiable bytes.
				if (computeArtifactDigest(skillMarkdown) !== promotedContentHash) {
					return JSON.stringify({
						success: false,
						error:
							'Refusing to promote: final artifact digest does not match the promoted content hash — nothing was written',
					});
				}

				// Stage B round 4 — the final artifact (body + frontmatter)
				// must stay within the synchronous verification bound, or the
				// promoted skill is dead on arrival (oversized artifact refused
				// by the verifier and by revoke). Checked BEFORE re-validation
				// so the refusal fires for any oversized candidate regardless
				// of gate outcome.
				const artifactByteLength = Buffer.byteLength(skillMarkdown, 'utf8');
				if (artifactByteLength > PROMOTED_ARTIFACT_MAX_BYTES) {
					return JSON.stringify({
						success: false,
						error: `Refusing to promote: the promoted artifact would be ${artifactByteLength} bytes, exceeding the PROMOTED_ARTIFACT_MAX_BYTES verification bound (${PROMOTED_ARTIFACT_MAX_BYTES}) — reduce the skill body before promoting.`,
					});
				}

				// Closeout round — the identity verifier reads NO record when the
				// candidate store holds more than MAX_PROMOTION_RECORD_FILES
				// files (it bounds the synchronous work done on every
				// delegation) and then refuses every CLAIMED artifact as
				// indeterminate. Promoting into such a store would report success
				// for a skill that is dead on arrival. Refuse before writing.
				// The check is POINT-IN-TIME (documented in the release
				// fragment): a record added concurrently in the instant between
				// this count and the promotion can still cross a store that sits
				// exactly at the cap — the gate then fails closed (refuses the
				// skill) until old records are removed. Closing that window needs
				// the store-level locking tracked in the unlocked-update follow-up.
				const recordFileCount =
					await _internals.countCandidateRecords(directory);
				if (recordFileCount > MAX_PROMOTION_RECORD_FILES) {
					return JSON.stringify({
						success: false,
						error: `Refusing to promote: the candidate store holds ${recordFileCount} record files, above the ${MAX_PROMOTION_RECORD_FILES}-file scan cap (MAX_PROMOTION_RECORD_FILES) the identity verifier reads — a promoted skill would be refused by the propagation gate. Remove or evict old candidate records, then retry.`,
					});
				}

				// Stage B round 9 — the propagation gate reads only the first
				// SKILL_FRONTMATTER_READ_BYTES of a SKILL.md to extract its
				// metadata and rejects a skill whose closing fence is not inside
				// that window BEFORE identity verification ever runs. publisher /
				// source_url (each up to the validator's field cap) are written
				// raw into the frontmatter, so an otherwise valid candidate could
				// promote "successfully" into an artifact the gate can never
				// load. Refuse before writing anything.
				const frontmatterLines = skillMarkdown.split('\n');
				const frontmatterEnd = frontmatterLines.findIndex(
					(line, index) => index > 0 && line.trim() === '---',
				);
				const frontmatterBytes = Buffer.byteLength(
					frontmatterLines.slice(0, frontmatterEnd + 1).join('\n'),
					'utf8',
				);
				if (
					frontmatterEnd === -1 ||
					frontmatterBytes > SKILL_FRONTMATTER_READ_BYTES
				) {
					return JSON.stringify({
						success: false,
						error: `Refusing to promote: the artifact frontmatter would be ${frontmatterBytes} bytes, exceeding the SKILL_FRONTMATTER_READ_BYTES metadata window (${SKILL_FRONTMATTER_READ_BYTES}) the propagation gate reads — shorten the candidate's publisher / source_url before promoting.`,
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

				// Stage B round 5 — the EXACT post-update record must stay
				// within the synchronous verification bound. A fixed reserve
				// cannot bound the promotion history entry: it duplicates
				// publisher and source_url (each individually valid up to the
				// validator's 10k per-field cap) and copies prior evaluation
				// details, so a near-bound candidate could promote into a
				// record the verifier then refuses as oversized. Build the
				// exact updated candidate with the SAME patch builder the
				// store's update uses (applyCandidatePatch) and serialize with
				// the store's settings (tab indent), so measured bytes and
				// persisted bytes cannot drift. The only store-stamped field,
				// the system entry's timestamp, is always a fixed-length ISO
				// string, so the injected instant adds no measurement error —
				// no extra safety margin is needed.
				const promotionPatch = {
					evaluation_verdict: 'promoted' as const,
					evaluation_history: [auditEntry],
				};
				const postUpdateRecordBytes = Buffer.byteLength(
					JSON.stringify(
						applyCandidatePatch(candidate, promotionPatch, timestamp),
						null,
						'\t',
					),
					'utf8',
				);
				if (postUpdateRecordBytes > PROMOTION_RECORD_MAX_BYTES) {
					return JSON.stringify({
						success: false,
						error: `Refusing to promote: the candidate record after the promotion history entry would be ${postUpdateRecordBytes} bytes, exceeding the PROMOTION_RECORD_MAX_BYTES verification bound (${PROMOTION_RECORD_MAX_BYTES}) — trim the candidate history or metadata before promoting.`,
					});
				}

				// Check for slug collision — reject if SKILL.md already exists
				const alreadyExists = await _internals.fileExists(targetPath);
				if (alreadyExists) {
					return JSON.stringify({
						success: false,
						error: `Skill '${sanitizedSlug}' already exists at ${targetPath}. Use a different slug or retire the existing skill first.`,
					});
				}

				// Lifecycle-marker gate (#3951 NF-3): a retired/stale marker left
				// in an EMPTIED slug (retireSkill keeps SKILL.md, so a present
				// skill hit the collision gate above; only an explicit revoke
				// leaves the marker alone in the directory) would make this
				// promotion succeed while the propagation gate refuses the new
				// skill on the marker BEFORE digest verification — an unusable
				// artifact. Refuse BEFORE any mutation with a marker-specific
				// remedy; retirement stays reversible for skills still present
				// (they never reach this branch — #1822 contract untouched).
				const markerState = await readLifecycleMarkerState(
					path.dirname(targetPath),
				);
				if (markerState.blocked) {
					return JSON.stringify({
						success: false,
						error: markerState.diagnostic,
					});
				}

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

				// Update candidate: set verdict to promoted and append history.
				// The cap is passed INTO the real update (Stage B round 6): the
				// pre-write measurement above uses promote's snapshot of the
				// candidate, but update() re-reads the record — a concurrent
				// mutation in that gap can only be caught against the ACTUAL
				// merged object inside the store.
				//
				// FB-107 + round 6 — on ANY update failure (thrown error, incl.
				// RecordTooLargeError) AND on a null result (the candidate
				// vanished between promote's read and the store's re-read),
				// best-effort remove the just-written artifact (only when its
				// bytes are still ours) so no orphan with a provenance claim is
				// left behind; a thrown error is rethrown so the ORIGINAL cause
				// stays the surfaced error, and a null result is an explicit
				// actionable failure — never a success.
				let updatedRecord: ExternalSkillCandidate | null;
				try {
					updatedRecord = await store.update(candidateId, promotionPatch, {
						maxRecordBytes: PROMOTION_RECORD_MAX_BYTES,
					});
				} catch (updateErr) {
					await cleanupOrphanedArtifact(targetPath, skillMarkdown);
					throw updateErr;
				}
				if (updatedRecord === null) {
					const cleaned = await cleanupOrphanedArtifact(
						targetPath,
						skillMarkdown,
					);
					return JSON.stringify({
						success: false,
						error: `Failed to promote candidate: the candidate record disappeared before the promotion entry could be written (deleted concurrently). ${
							cleaned
								? 'The just-written artifact was removed.'
								: `The just-written artifact could not be confirmed removed (it was replaced or the removal failed); inspect ${targetPath}.`
						}`,
					});
				}

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
