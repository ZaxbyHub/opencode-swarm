/**
 * External-skill artifact identity (#3822).
 *
 * Approval of an external-skill candidate is bound to the VERIFIED BYTES of
 * the promoted artifact, recorded in the structured candidate store
 * (`<project>/.swarm/skills/candidates/<uuid>.json` — the promotion history
 * entry's `target_path` + `promoted_content_hash`), never to the mutable
 * artifact frontmatter. This module owns the primitives every
 * trust-consumption point shares:
 *
 *   - `computeArtifactDigest` — the canonical, non-self-referential digest.
 *   - `lookupPromotionRecordByPathSync` — path-first promotion-record
 *     resolution from the structured store.
 *   - `verifyPromotedExternalSkillSync` — digest enforcement for artifacts
 *     under `.opencode/skills/generated/` (used by the propagation gate).
 *
 * ## Canonical digest — exact bytes
 *
 * `computeArtifactDigest(content)` returns the lowercase-hex SHA-256 of the
 * complete `content` string (UTF-8 bytes) after replacing the FIRST line
 * that begins with `content_digest:` (through end of line) — the artifact's
 * own advisory digest line — with the fixed ASCII placeholder line
 * `content_digest: <recorded>` (no trailing newline). Replacing rather than
 * deleting the line keeps the
 * digest stable when the line's VALUE changes, which is exactly what happens
 * when the digest is stamped into the frontmatter at promotion time. An
 * artifact without a `content_digest:` line hashes as-is — byte-identical to
 * the pre-#3822 whole-file SHA-256, so `promoted_content_hash` values written
 * by earlier releases (raw whole-file hashes) keep verifying.
 *
 * ## Legacy rule (approved owner decision ASK-2)
 *
 * A promoted-external artifact whose promotion record carries NO structured
 * full-file hash (`promoted_content_hash` absent) is still accepted when the
 * record exists and the candidate's OLD body-only `sha256` matches the
 * artifact's body — everything after the closing frontmatter divider with the
 * single separator newline stripped (the byte layout every promote release
 * has written). This keeps already-promoted skills loadable; every promotion
 * performed after this change carries the structured hash.
 *
 * ## Sync/async reconciliation (#3822 K1(d) — implementation choice)
 *
 * `validateSkillReference` (skill-propagation-gate) is synchronous while the
 * candidate-store API is async. Rather than add a synchronous accessor to
 * the store (duplicating its parsing/containment logic), this module reads
 * the candidate JSON files directly with `fs.readFileSync`, bounded per file
 * (`PROMOTION_RECORD_MAX_BYTES`) and in file count
 * (`MAX_PROMOTION_RECORD_FILES`). The scan is skipped entirely when
 * `<project>/.swarm/skills/candidates/` does not exist — the common project
 * has no external-skill store, so ordinary generated skills pay only one
 * bounded head read for provenance detection. When the scan hits a bound, or
 * a record file is unreadable/corrupted, absence of a matching record cannot
 * be proven and verification fails closed (`status: 'indeterminate'`):
 * silently skipping an unreadable record would let whoever corrupted it
 * hide that record's promotion identity.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Fixed placeholder line substituted for the artifact's own digest line
 * before hashing (keeps the digest non-self-referential).
 */
export const ARTIFACT_DIGEST_PLACEHOLDER_LINE = 'content_digest: <recorded>';

/** Byte bound for synchronous hashing of a promoted skill artifact (1 MiB). */
export const PROMOTED_ARTIFACT_MAX_BYTES = 1_048_576;

/** Head bytes used for provenance detection before any full read. */
export const PROVENANCE_HEAD_BYTES = 8_192;

/** Bound on candidate record files scanned per lookup (store default is 500). */
export const MAX_PROMOTION_RECORD_FILES = 1000;

/** Per-file byte bound while scanning candidate records (1 MiB). */
export const PROMOTION_RECORD_MAX_BYTES = 1_048_576;

/** A promotion record resolved from the structured candidate store. */
export interface PromotedExternalRecord {
	/** Candidate UUID that owns the promotion. */
	candidateId: string;
	/** Resolved absolute target path recorded at promotion. */
	targetPath: string;
	/** Canonical full-file digest (`promoted_content_hash`). Legacy records may lack it. */
	promotedContentHash?: string;
	/** Candidate body-only sha256 (the pre-#3822 identity, legacy ASK-2 path). */
	bodySha256?: string;
}

/**
 * Path-first lookup outcome.
 *
 * `indeterminate` means the scan could not prove absence of a record (bound
 * hit, or an unreadable/corrupted record file) — callers must fail closed.
 */
export type PromotionRecordLookup =
	| { status: 'found'; record: PromotedExternalRecord }
	| { status: 'not-found' }
	| { status: 'indeterminate' };

// ---------------------------------------------------------------------------
// Canonical digest
// ---------------------------------------------------------------------------

/**
 * Compute the canonical artifact digest (#3822 K1(b)).
 *
 * See the module docstring for the exact byte specification. Deterministic
 * for a given artifact content regardless of the VALUE on the artifact's own
 * `content_digest:` line — which is what makes stamping the digest into the
 * frontmatter possible without invalidating the record.
 */
export function computeArtifactDigest(content: string): string {
	const canonical = content.replace(
		/^content_digest:[^\n]*/m,
		ARTIFACT_DIGEST_PLACEHOLDER_LINE,
	);
	return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Provenance detection helpers
// ---------------------------------------------------------------------------

/** Frontmatter lines that mark an artifact as a promoted external skill. */
const PROMOTED_PROVENANCE_LINES = new Set([
	'skill_origin: promoted_external',
	'promoted_from: external-skill-candidate',
]);

/** True when the content (frontmatter head is enough) claims promoted-external provenance. */
function detectProvenanceClaim(head: string): boolean {
	for (const rawLine of head.split('\n')) {
		if (PROMOTED_PROVENANCE_LINES.has(rawLine.trim())) {
			return true;
		}
	}
	return false;
}

/** Extract `candidate_id` from the leading frontmatter block, if present. */
function extractFrontmatterCandidateId(head: string): string | null {
	let inFrontmatter = false;
	for (const rawLine of head.split('\n')) {
		const line = rawLine.trim();
		if (!inFrontmatter) {
			if (line === '---') inFrontmatter = true;
			continue;
		}
		if (line === '---') break;
		const match = /^candidate_id:[ \t]*(\S+)$/.exec(line);
		if (match) return match[1] ?? null;
	}
	return null;
}

/**
 * Extract the artifact body (everything after the closing frontmatter
 * divider, with the single separator newline stripped) — the legacy ASK-2
 * comparison basis. Returns `null` when no frontmatter block is present.
 */
function extractBodyAfterFrontmatter(content: string): string | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return null;
	const body = match[2] ?? '';
	if (body.startsWith('\r\n')) return body.slice(2);
	if (body.startsWith('\n')) return body.slice(1);
	return body;
}

// ---------------------------------------------------------------------------
// Path identity
// ---------------------------------------------------------------------------

/** Case-normalized path key (win32 paths compare case-insensitively). */
function pathIdentityKey(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Both stable identities of a path: the lexically resolved form and (when it
 * exists) the realpath form. Two spellings of the same file (e.g. a store
 * record written through a symlinked project root) match on at least one key.
 */
function pathIdentityKeys(absolutePath: string): Set<string> {
	const keys = new Set<string>([pathIdentityKey(absolutePath)]);
	try {
		keys.add(pathIdentityKey(fs.realpathSync(absolutePath)));
	} catch {
		// Missing or unreadable — the resolved form is the only identity.
	}
	return keys;
}

// ---------------------------------------------------------------------------
// Record resolution (bounded synchronous scan — see module docstring)
// ---------------------------------------------------------------------------

/** SHA-256 shape accepted for structured hashes. */
const HEX64_RE = /^[a-f0-9]{64}$/;

/**
 * The newest 'promoted' history entry that carries a structured
 * `target_path`. Automatic history entries lacking the field are skipped.
 * `promotedContentHash` is null when the entry is the legacy shape (ASK-2).
 */
function newestStructuredPromotionEntry(
	history: unknown,
): { targetPath: string; promotedContentHash: string | null } | null {
	if (!Array.isArray(history)) return null;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (!entry || typeof entry !== 'object') continue;
		const record = entry as Record<string, unknown>;
		if (record.verdict !== 'promoted') continue;
		const targetPath =
			typeof record.target_path === 'string' ? record.target_path.trim() : '';
		if (!targetPath) continue;
		const promotedContentHash =
			typeof record.promoted_content_hash === 'string' &&
			HEX64_RE.test(record.promoted_content_hash)
				? record.promoted_content_hash
				: null;
		// The newest promoted entry carrying a target path is this candidate's
		// authoritative promotion identity; older entries are stale.
		return { targetPath, promotedContentHash };
	}
	return null;
}

/**
 * Resolve the promotion record for an artifact BY CANONICAL PATH (#3822
 * K1(c)) — `candidate_id` frontmatter is NOT the lookup key, so deleting the
 * provenance fields cannot disguise a promoted artifact.
 */
export function lookupPromotionRecordByPathSync(
	directory: string,
	artifactAbsolutePath: string,
): PromotionRecordLookup {
	const candidatesDir = path.join(directory, '.swarm', 'skills', 'candidates');
	let names: string[];
	try {
		names = fs.readdirSync(candidatesDir);
	} catch {
		// No store (or unreadable directory) — nothing promoted from here.
		return { status: 'not-found' };
	}

	const jsonNames = names.filter((name) => name.endsWith('.json'));
	if (jsonNames.length > MAX_PROMOTION_RECORD_FILES) {
		return { status: 'indeterminate' };
	}

	const artifactKeys = pathIdentityKeys(artifactAbsolutePath);
	let sawUnverifiableRecord = false;

	for (const name of jsonNames) {
		const file = path.join(candidatesDir, name);
		let raw: string;
		try {
			const st = fs.statSync(file);
			if (!st.isFile() || st.size > PROMOTION_RECORD_MAX_BYTES) {
				sawUnverifiableRecord = true;
				continue;
			}
			raw = fs.readFileSync(file, 'utf-8');
		} catch {
			sawUnverifiableRecord = true;
			continue;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			// A corrupted record could be the one that binds this artifact.
			sawUnverifiableRecord = true;
			continue;
		}
		if (!parsed || typeof parsed !== 'object') continue;
		const candidate = parsed as Record<string, unknown>;

		const promotion = newestStructuredPromotionEntry(
			candidate.evaluation_history,
		);
		if (!promotion) continue;

		const resolvedTarget = path.resolve(directory, promotion.targetPath);
		const targetKeys = pathIdentityKeys(resolvedTarget);
		let matches = false;
		for (const key of targetKeys) {
			if (artifactKeys.has(key)) {
				matches = true;
				break;
			}
		}
		if (!matches) continue;

		const record: PromotedExternalRecord = {
			candidateId:
				typeof candidate.id === 'string' && candidate.id.length > 0
					? candidate.id
					: name.replace(/\.json$/, ''),
			targetPath: resolvedTarget,
		};
		if (promotion.promotedContentHash !== null) {
			record.promotedContentHash = promotion.promotedContentHash;
		}
		if (
			typeof candidate.sha256 === 'string' &&
			HEX64_RE.test(candidate.sha256)
		) {
			record.bodySha256 = candidate.sha256;
		}
		return { status: 'found', record };
	}

	return sawUnverifiableRecord
		? { status: 'indeterminate' }
		: { status: 'not-found' };
}

// ---------------------------------------------------------------------------
// Verification entry point (propagation gate)
// ---------------------------------------------------------------------------

/** Bounded head read for provenance detection (never reads past the cap). */
function readHeadSync(filePath: string): string {
	const fd = fs.openSync(filePath, 'r');
	try {
		const buffer = Buffer.alloc(PROVENANCE_HEAD_BYTES);
		const bytesRead = fs.readSync(fd, buffer, 0, PROVENANCE_HEAD_BYTES, 0);
		return buffer.toString('utf-8', 0, bytesRead);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Verify a generated-root artifact against its promotion record (#3822 K1).
 *
 * Decision tree:
 *   - scan indeterminate            → refuse (cannot prove absence)
 *   - no record + provenance claim  → refuse (orphaned promotion claim)
 *   - no record + no claim          → accept (ordinary generated skill)
 *   - record found (path-first)     → frontmatter candidate_id, when present,
 *                                     must agree with the record; then the
 *                                     canonical digest (or, for legacy
 *                                     records without a structured hash, the
 *                                     body-only sha256) must match the
 *                                     on-disk bytes.
 *
 * Fail-closed on mismatch, missing digest, unreadable, or oversized files.
 */
export function verifyPromotedExternalSkillSync(
	directory: string,
	artifactAbsolutePath: string,
): { ok: true } | { ok: false; reason: string } {
	let head: string;
	let size: number;
	try {
		const st = fs.statSync(artifactAbsolutePath);
		if (!st.isFile()) {
			return {
				ok: false,
				reason: 'promoted skill artifact is not a regular file',
			};
		}
		size = st.size;
		head = readHeadSync(artifactAbsolutePath);
	} catch {
		return { ok: false, reason: 'promoted skill artifact is unreadable' };
	}

	const lookup = lookupPromotionRecordByPathSync(
		directory,
		artifactAbsolutePath,
	);
	if (lookup.status === 'indeterminate') {
		return {
			ok: false,
			reason:
				'cannot verify generated skill identity — the external-skill candidate store exceeds the synchronous verification bound',
		};
	}
	if (lookup.status === 'not-found') {
		if (detectProvenanceClaim(head)) {
			return {
				ok: false,
				reason:
					'promoted external skill has no matching promotion record in the candidate store',
			};
		}
		return { ok: true };
	}

	// Record found — the path (not the frontmatter) owns the identity.
	const frontCandidateId = extractFrontmatterCandidateId(head);
	if (
		frontCandidateId !== null &&
		frontCandidateId !== lookup.record.candidateId
	) {
		return {
			ok: false,
			reason: `promoted external skill candidate_id mismatch (frontmatter "${frontCandidateId}" does not match the recorded promotion)`,
		};
	}

	let content: string;
	try {
		if (size > PROMOTED_ARTIFACT_MAX_BYTES) {
			return {
				ok: false,
				reason: `promoted skill artifact exceeds the ${PROMOTED_ARTIFACT_MAX_BYTES}-byte digest bound`,
			};
		}
		content = fs.readFileSync(artifactAbsolutePath, 'utf-8');
	} catch {
		return { ok: false, reason: 'promoted skill artifact is unreadable' };
	}

	if (lookup.record.promotedContentHash !== undefined) {
		const digest = computeArtifactDigest(content);
		if (digest !== lookup.record.promotedContentHash) {
			return {
				ok: false,
				reason:
					'promoted external skill content digest does not match the recorded promotion hash',
			};
		}
		return { ok: true };
	}

	// Legacy record without a structured full-file hash (approved ASK-2):
	// accept when the OLD body-only sha256 still matches the artifact body.
	if (lookup.record.bodySha256 === undefined) {
		return {
			ok: false,
			reason: 'promotion record carries no verifiable content hash',
		};
	}
	const body = extractBodyAfterFrontmatter(content);
	if (
		body === null ||
		createHash('sha256').update(body).digest('hex') !== lookup.record.bodySha256
	) {
		return {
			ok: false,
			reason:
				'promoted external skill body no longer matches the recorded candidate hash',
		};
	}
	return { ok: true };
}
