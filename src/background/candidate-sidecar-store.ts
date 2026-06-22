import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
// proper-lockfile is a CommonJS module without published TypeScript types.
// Import the default (the `lock` async function) and cast to `any` to access
// the synchronous lockSync/unlockSync helpers without type errors.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { validateSwarmPath } from '../hooks/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hash algorithm used to derive batchDigest from batchId (Option A). */
const BATCH_DIGEST_ALGORITHM = 'sha256';

/**
 * ANSI escape stripping strategy — full sequence removal (FR-021).
 *
 * A complete ANSI escape sequence is `ESC [ <params> <intermediate> <final-byte>`
 * for CSI, `ESC ] ... BEL` for OSC, or `ESC X` for two-character sequences.
 * The state machine below consumes and discards the entire sequence.
 */

// ---------------------------------------------------------------------------
// Zod schemas for write-time record validation
// ---------------------------------------------------------------------------

/** Schema for invocation-envelope records written to the sidecar. */
const SidecarEnvelopeSchema = z
	.object({
		record_type: z.literal('invocation'),
		source_output_ref: z.string().min(1),
		source_batch_id: z.string().min(1),
		source_lane_id: z.string().min(1),
		source_agent: z.string().min(1),
		source_digest: z.string().regex(/^[a-f0-9]{64}$/),
		row_format_version: z.number().int().nonnegative(),
		producer: z.string().optional(),
		produced_at: z.string().min(1),
		record_version: z.object({
			major: z.number().int().nonnegative(),
			minor: z.number().int().nonnegative(),
		}),
		sessionId: z.string().min(1).optional(),
		parentSessionId: z.string().min(1).optional(),
		format_families_detected: z.array(z.string()),
		candidate_count: z.number().int().nonnegative(),
		parse_errors: z.number().int().nonnegative(),
		malformed_rows: z.number().int().nonnegative(),
	})
	.strict();

/** Schema for candidate records written to the sidecar. */
const SidecarCandidateSchema = z
	.object({
		record_type: z.literal('candidate'),
		row_format_family: z.enum(['base_explorer', 'micro_lane']),
		row_format_version: z.number().int().nonnegative(),
		record_version: z.object({
			major: z.number().int().nonnegative(),
			minor: z.number().int().nonnegative(),
		}),
		source_output_ref: z.string().min(1),
		source_batch_id: z.string().min(1),
		source_lane_id: z.string().min(1),
		source_agent: z.string().min(1),
		source_digest: z.string().regex(/^[a-f0-9]{64}$/),
		sessionId: z.string().min(1).optional(),
		parentSessionId: z.string().min(1).optional(),
		producer: z.string().optional(),
		extracted_from_partial_source: z.boolean(),
		candidate_id: z.string().min(1),
		lane: z.string().nullable(),
		micro_lane: z.string().nullable(),
		severity: z.string().nullable(),
		category: z.string().nullable(),
		file_line: z.string().nullable(),
		claim: z.string().nullable(),
		evidence_summary: z.string().nullable(),
		impact_context: z.string().nullable(),
		invariant_violated: z.string().nullable(),
		confidence: z.string().nullable(),
	})
	.strict();

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SidecarStoreOptions {
	/** Project root directory (the OpenCode process working directory). */
	projectRoot: string;
	/** Override the batch digest. When omitted, SHA-256(batchId) is used. */
	batchDigest?: string;
	/**
	 * When true, acquire a `proper-lockfile` lock on the batch directory
	 * before the append and release it afterwards.  Default: false (no lock —
	 * matches the existing append-only pattern the codebase already uses).
	 *
	 * On lock acquisition failure the function throws; the caller
	 * (`parseAndPersist`) catches and records `sidecar_write_error`.
	 */
	useLockfile?: boolean;
}

// ---------------------------------------------------------------------------
// Content sanitization (FR-021)
// ---------------------------------------------------------------------------

/**
 * Unicode code-point ranges for bidirectional override / isolate markers
 * (Trojan Source / CVE-2021-42574).  All are stripped from the persisted copy.
 */
const BIDI_RANGES: [number, number][] = [
	[0x202a, 0x202e], // LRE, RLE, PDF, LRO, RLO
	[0x2066, 0x2069], // LRI, RLI, FSI, PDI
];

/**
 * Return true if the given code point falls within any of the tracked
 * bidirectional override / isolate ranges.
 */
function isBidiCodePoint(code: number): boolean {
	for (let i = 0; i < BIDI_RANGES.length; i++) {
		const [lo, hi] = BIDI_RANGES[i];
		if (code >= lo && code <= hi) return true;
	}
	return false;
}

/**
 * Sanitize a single string value for sidecar persistence.
 *
 * Transformations applied in order:
 * 1. NUL bytes (`\x00`) → `\u0000` escape (preserves information).
 * 2. ANSI escape sequences (`\x1B[...]`) → entire sequence stripped.
 *    Handles CSI (`ESC [ params intermediate final`), OSC (`ESC ] ... BEL/ST`),
 *    and two-character escape sequences.
 * 3. Unicode bidi markers (U+202A–U+202E, U+2066–U+2069) → stripped.
 *
 * All other characters pass through unchanged.
 *
 * @param value - Raw string value (may contain NUL bytes, ANSI, bidi markers).
 * @returns Sanitized string safe for JSONL persistence.
 */
export function sanitizeString(value: string): string {
	let result = '';
	for (let i = 0; i < value.length; i++) {
		const code = value.codePointAt(i) ?? 0;
		if (code > 0xffff) {
			// Surrogate pair: append both the high surrogate (current i) and
			// the low surrogate (i+1), then advance past the pair.
			result += value[i];
			i++;
			result += value[i];
		} else if (code === 0x00) {
			// FR-021 rule 1: NUL → \u0000 (preserves information, JSON-safe)
			result += '\\u0000';
		} else if (code === 0x1b) {
			// FR-021 rule 2: strip the entire ANSI escape sequence
			// CSI: ESC [ params intermediate final
			// OSC: ESC ] ... BEL or ESC \
			// Two-char: ESC intermediate final

			if (i + 1 < value.length && value[i + 1] === '[') {
				// CSI: skip '[', then consume params (0x30-0x3F), intermediate (0x20-0x2F), final (0x40-0x7E)
				i++; // skip '['
				while (i + 1 < value.length) {
					const next = value.charCodeAt(i + 1);
					if (next >= 0x30 && next <= 0x3f) {
						i++; // parameter byte
					} else if (next >= 0x20 && next <= 0x2f) {
						i++; // intermediate byte
					} else if (next >= 0x40 && next <= 0x7e) {
						i++; // final byte
						break;
					} else {
						break; // unrecognized — stop
					}
				}
			} else if (i + 1 < value.length && value[i + 1] === ']') {
				// OSC: skip ']', then everything until BEL (0x07) or ST (\x1B\\)
				i++; // skip ']'
				while (i + 1 < value.length) {
					const next = value.charCodeAt(i + 1);
					if (next === 0x07) {
						i++; // BEL terminator
						break;
					} else if (
						next === 0x1b &&
						i + 2 < value.length &&
						value[i + 2] === '\\'
					) {
						i += 2; // ST terminator (\x1B\\)
						break;
					} else {
						i++;
					}
				}
			} else if (i + 1 < value.length) {
				// Other two-character escape: skip next byte (intermediate/final)
				const next = value.charCodeAt(i + 1);
				if (next >= 0x20 && next <= 0x2f) {
					// Has intermediate bytes — skip them, then final byte
					i++;
					while (i + 1 < value.length) {
						const b = value.charCodeAt(i + 1);
						if (b >= 0x30 && b <= 0x7e) {
							i++;
							break;
						} else if (b >= 0x20 && b <= 0x2f) {
							i++;
						} else {
							break;
						}
					}
				} else if (next >= 0x30 && next <= 0x7e) {
					// Direct final byte (e.g., ESC 7 for save cursor)
					i++;
				}
				// else: unrecognized — just drop the ESC
			}
			// Note: the outer for-loop's i++ advances past the final byte
		} else if (isBidiCodePoint(code)) {
			// FR-021 rule 3: bidi override / isolate markers stripped — skip this character
		} else {
			result += value[i];
		}
	}
	return result;
}

/**
 * Recursively walk a parsed record object and sanitize every string value.
 *
 * - Plain strings: replaced with `sanitizeString(value)`.
 * - `null` values: passed through unchanged.
 * - Nested objects: each value sanitized recursively.
 * - Arrays: each element sanitized recursively.
 * - Numbers, booleans: passed through unchanged.
 *
 * The function mutates the supplied record in place and returns it for
 * convenience, matching the pattern used by the caller.
 */
function sanitizeRecord(
	record: Record<string, unknown>,
): Record<string, unknown> {
	for (const key of Object.keys(record)) {
		const value = record[key];
		if (typeof value === 'string') {
			record[key] = sanitizeString(value);
		} else if (value !== null && typeof value === 'object') {
			if (Array.isArray(value)) {
				for (let i = 0; i < value.length; i++) {
					const element = value[i];
					if (typeof element === 'string') {
						value[i] = sanitizeString(element);
					} else if (element !== null && typeof element === 'object') {
						sanitizeRecord(element as Record<string, unknown>);
					}
				}
			} else {
				sanitizeRecord(value as Record<string, unknown>);
			}
		}
		// Numbers, booleans, nulls: pass through unchanged.
	}
	return record;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the batch digest from a batchId using SHA-256 (Option A).
 *
 * This mirrors how lane-output-store.ts derives its digest internally,
 * keeping the caller from having to compute or pass a digest explicitly.
 */
function computeBatchDigest(batchId: string): string {
	return createHash(BATCH_DIGEST_ALGORITHM).update(batchId).digest('hex');
}

/**
 * Return the relative path within `.swarm/` for a batch's candidates sidecar.
 */
function sidecarRelativePath(batchDigest: string): string {
	return path.join('lane-results', batchDigest, 'candidates.jsonl');
}

/**
 * Validate a single record against its Zod schema. Throws on failure so the
 * caller can report the error via sidecar_write_error.
 */
function validateRecord(
	record: unknown,
	schema: z.ZodType,
	label: string,
): void {
	const result = schema.safeParse(record);
	if (!result.success) {
		throw new Error(
			`Sidecar ${label} schema validation failed: ${result.error.issues
				.map((i) => `${i.path.join('.')}: ${i.message}`)
				.join('; ')}`,
		);
	}
}

// ---------------------------------------------------------------------------
// proper-lockfile integration (FR-014)
// ---------------------------------------------------------------------------

/**
 * Acquire a synchronous lock on the batch directory via proper-lockfile,
 * run the write callback, then release the lock.
 *
 * Uses lockSync/release so the surrounding function signature does not
 * need to change (existing callers and tests remain synchronous).
 */
function withLockfile<T>(lockDir: string, write: () => T): T {
	const lockPath = path.join(lockDir, '.lock');
	// proper-lockfile has no published TypeScript declarations.
	interface Lockfile {
		lockSync(
			path: string,
			options: {
				realpath: boolean;
			},
		): () => void;
	}
	const lf = lockfile as unknown as Lockfile;
	const release = lf.lockSync(lockPath, {
		realpath: false, // sentinel file doesn't exist; rely on directory lock
	});
	try {
		return write();
	} finally {
		release();
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append an invocation envelope followed by zero or more candidate records
 * to the sidecar JSONL file for the given batch.
 *
 * The envelope is always the first record in the append batch (SC-015).
 * Cross-skill coexistence is enabled via the `producer` field on the
 * envelope (FR-019).
 *
 * Content sanitization (FR-021) is applied to the persisted copy: NUL bytes
 * are escaped to `\u0000`, ANSI ESC bytes are stripped, and Unicode bidi
 * markers are stripped.  The caller's in-memory records are NOT mutated.
 *
 * Concurrency safety (FR-014): when `options.useLockfile` is true, a
 * `proper-lockfile` lock is acquired on the batch directory before the
 * append and released afterwards.  Lock acquisition failures propagate as
 * throws.  Default behaviour (useLockfile omitted or false) is lockless
 * append — the existing pattern used throughout the codebase.
 *
 * @param options  Store configuration (projectRoot, optional batchDigest, useLockfile).
 * @param batchId  The batch identifier (used to derive batchDigest when not provided).
 * @param envelope The invocation envelope record (validated before write).
 * @param candidates Candidate records to append after the envelope (validated before write).
 * @throws If schema validation fails, lock acquisition fails, or the filesystem write fails.
 */
export function appendToSidecar(
	options: SidecarStoreOptions,
	batchId: string,
	envelope: unknown,
	candidates: unknown[],
): void {
	const batchDigest = options.batchDigest ?? computeBatchDigest(batchId);
	const relPath = sidecarRelativePath(batchDigest);
	const absPath = validateSwarmPath(options.projectRoot, relPath);

	// Write-time schema validation (per "validate at WRITE time" invariant).
	validateRecord(envelope, SidecarEnvelopeSchema, 'envelope');
	for (let i = 0; i < candidates.length; i++) {
		validateRecord(candidates[i], SidecarCandidateSchema, `candidate[${i}]`);
	}

	// Ensure parent directory exists.
	mkdirSync(path.dirname(absPath), { recursive: true });

	// FR-021: sanitize the PERSISTED copy only.  We deep-clone each record
	// so the caller's in-memory objects are never mutated (SC-025).
	const sanitizedEnvelope = sanitizeRecord(
		structuredClone(envelope) as Record<string, unknown>,
	);
	const sanitizedCandidates = candidates.map((c) =>
		sanitizeRecord(structuredClone(c) as Record<string, unknown>),
	);

	// JSONL: one JSON object per line, no trailing commas, envelope first.
	const lines: string[] = [JSON.stringify(sanitizedEnvelope)];
	for (const candidate of sanitizedCandidates) {
		lines.push(JSON.stringify(candidate));
	}
	const payload = `${lines.join('\n')}\n`;

	// FR-014: optional proper-lockfile lock on the batch directory.
	const doWrite = (): void => {
		appendFileSync(absPath, payload, 'utf-8');
	};

	if (options.useLockfile) {
		withLockfile(path.dirname(absPath), doWrite);
	} else {
		doWrite();
	}
}
