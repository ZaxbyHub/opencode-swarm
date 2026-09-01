/**
 * Identity primitives for the observability event contract (issue #2029).
 *
 * Scope rules for this whole module directory:
 *   - `node:crypto` and `zod` are the ONLY permitted imports.
 *   - No filesystem, no network, no subprocess, no dynamic import, no runtime
 *     dependency on any OpenTelemetry SDK.
 *   - No import-time side effects beyond `const` data definitions.
 *
 * Identity design:
 *   - `traceId` / `spanId` are W3C Trace Context compatible (16-byte / 8-byte
 *     lowercase hex). The W3C spec declares an all-zero id invalid, so both
 *     generators regenerate rather than return one.
 *   - Lineage refs (`projectRef` / `cohortRef` / `worktreeRef`) are salted,
 *     truncated SHA-256 digests. They are PSEUDONYMS, not anonymous values: the
 *     digest never contains or encodes the path, but with the PUBLIC
 *     {@link DEFAULT_LINEAGE_SALT} and a low-entropy path space a holder of an
 *     export can CONFIRM a guessed path by re-hashing candidates. Setting
 *     {@link LINEAGE_SALT_ENV} to a private per-install value restores
 *     guess-resistance and cross-install unlinkability (issue #2029 item 2 /
 *     AC3). A per-install persisted salt would need init-path I/O, which
 *     AGENTS.md invariant 1 forbids; that belongs with #2047.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Byte width of a W3C `trace-id`. */
const TRACE_ID_BYTES = 16;

/** Byte width of a W3C `parent-id` (span id). */
const SPAN_ID_BYTES = 8;

/** Hex width of a W3C `trace-id`. */
export const TRACE_ID_HEX_LENGTH = TRACE_ID_BYTES * 2;

/** Hex width of a W3C span id. */
export const SPAN_ID_HEX_LENGTH = SPAN_ID_BYTES * 2;

const ALL_ZERO_TRACE_ID = '0'.repeat(TRACE_ID_HEX_LENGTH);
const ALL_ZERO_SPAN_ID = '0'.repeat(SPAN_ID_HEX_LENGTH);

/**
 * Sentinel ids returned only if the CSPRNG produced an all-zero value on every
 * attempt. The probability is 2^-128 (trace) / 2^-64 (span) per attempt, so this
 * branch is unreachable in practice; it exists so the functions can never return
 * a W3C-invalid all-zero id.
 */
const SENTINEL_TRACE_ID = `${'0'.repeat(TRACE_ID_HEX_LENGTH - 1)}1`;
const SENTINEL_SPAN_ID = `${'0'.repeat(SPAN_ID_HEX_LENGTH - 1)}1`;

/** Regeneration attempts before falling back to a sentinel id. */
const MAX_REGENERATION_ATTEMPTS = 4;

/**
 * Environment variable that overrides the lineage salt.
 *
 * Deliberately NOT read at module scope: reading `process.env` during module
 * evaluation would make the salt depend on import order and would defeat any
 * test that sets it after import. `resolveLineageSalt()` reads it per call.
 */
export const LINEAGE_SALT_ENV = 'SWARM_OBSERVABILITY_LINEAGE_SALT';

/**
 * Salt used when {@link LINEAGE_SALT_ENV} is unset.
 *
 * A constant default is intentional: lineage refs must be stable for a given
 * path across processes and restarts, otherwise `projectRef` could not correlate
 * two runs of the same project. Operators who want cross-install unlinkability
 * set {@link LINEAGE_SALT_ENV} to a private value.
 */
export const DEFAULT_LINEAGE_SALT = 'opencode-swarm/observability/lineage/v1';

/**
 * Domain separator between the salt and the pseudonymized value.
 *
 * A NUL byte cannot occur in a filesystem path on any supported platform, so
 * the concatenation is unambiguous: `salt="ab", path="c"` and `salt="a",
 * path="bc"` cannot produce the same digest input.
 */
const LINEAGE_SEPARATOR = '\u0000';

/** Hex characters retained from the SHA-256 digest for a lineage ref. */
export const PSEUDONYMOUS_REF_LENGTH = 16;

/** A correlated `traceId` + `spanId` pair produced from one CSPRNG call. */
export interface TraceAndSpanId {
	readonly traceId: string;
	readonly spanId: string;
}

/**
 * Generate a W3C-compatible trace id: 32 lowercase hex characters, never
 * all-zero.
 *
 * NAME COLLISION, deliberate to record rather than rename: `newTraceId` in
 * `src/hooks/knowledge-events.ts` has the identical `(): string` signature but
 * a DIFFERENT on-wire shape — a 36-character RFC 4122 UUID, not 32 hex
 * characters. Nothing outside this directory imports this one, and it is no
 * longer re-exported from `src/observability/index.ts`, so the two cannot be
 * confused through the barrel. (`newEventId` is unaffected: both return
 * `randomUUID()`.)
 */
export function newTraceId(): string {
	for (let attempt = 0; attempt < MAX_REGENERATION_ATTEMPTS; attempt++) {
		const hex = randomBytes(TRACE_ID_BYTES).toString('hex');
		if (hex !== ALL_ZERO_TRACE_ID) return hex;
	}
	return SENTINEL_TRACE_ID;
}

/**
 * Generate a W3C-compatible span id: 16 lowercase hex characters, never
 * all-zero.
 */
export function newSpanId(): string {
	for (let attempt = 0; attempt < MAX_REGENERATION_ATTEMPTS; attempt++) {
		const hex = randomBytes(SPAN_ID_BYTES).toString('hex');
		if (hex !== ALL_ZERO_SPAN_ID) return hex;
	}
	return SENTINEL_SPAN_ID;
}

/** Generate an event id (RFC 4122 UUID v4). */
export function newEventId(): string {
	return randomUUID();
}

/**
 * Bytes drawn per refill of the entropy pool.
 *
 * `randomBytes` has meaningful per-call overhead, and `newTraceAndSpanId` runs on
 * the `emit()` hot path, whose frugality contract is documented at
 * src/telemetry.ts:393-396. Drawing one larger buffer and consuming it in slices
 * amortizes that overhead across {@link POOL_DRAWS} id pairs.
 *
 * This is strictly a batching change, NOT a weakening: every byte still comes
 * from the same CSPRNG (`node:crypto.randomBytes`), bytes are never reused, and
 * the pool is refilled once exhausted.
 */
const POOL_DRAWS = 128;
const POOL_BYTES = (TRACE_ID_BYTES + SPAN_ID_BYTES) * POOL_DRAWS;

let _pool: Buffer = Buffer.alloc(0);
let _poolOffset = Number.POSITIVE_INFINITY;

function takeIdBytes(): Buffer {
	const need = TRACE_ID_BYTES + SPAN_ID_BYTES;
	if (_poolOffset + need > _pool.length) {
		_pool = randomBytes(POOL_BYTES);
		_poolOffset = 0;
	}
	const slice = _pool.subarray(_poolOffset, _poolOffset + need);
	_poolOffset += need;
	return slice;
}

/**
 * Derive a correlated trace/span pair, consuming 24 bytes from the pool above.
 *
 * This exists for the hot path: `createObservation` runs on every `emit()`, and
 * src/telemetry.ts:393-396 documents that path as deliberately frugal.
 */
export function newTraceAndSpanId(): TraceAndSpanId {
	const buffer = takeIdBytes();
	const traceId = buffer.subarray(0, TRACE_ID_BYTES).toString('hex');
	const spanId = buffer.subarray(TRACE_ID_BYTES).toString('hex');
	if (traceId === ALL_ZERO_TRACE_ID || spanId === ALL_ZERO_SPAN_ID) {
		// Unreachable in practice; regenerate the pair independently rather than
		// return a W3C-invalid all-zero id.
		return { traceId: newTraceId(), spanId: newSpanId() };
	}
	return { traceId, spanId };
}

/**
 * Resolve the lineage salt.
 *
 * Reads {@link LINEAGE_SALT_ENV} at call time (never at module scope) and falls
 * back to {@link DEFAULT_LINEAGE_SALT}. Reading an environment variable is not
 * I/O — no file, socket, or subprocess is touched.
 */
export function resolveLineageSalt(): string {
	const configured = process.env[LINEAGE_SALT_ENV];
	if (typeof configured === 'string' && configured.length > 0)
		return configured;
	return DEFAULT_LINEAGE_SALT;
}

/**
 * Produce a pseudonymous reference for an absolute path.
 *
 * `sha256(salt + NUL + absolutePath)`, truncated to 16 hex characters.
 *
 * Properties this guarantees, and why each matters (issue #2029 item 2 / AC3):
 *   - The result never CONTAINS or ENCODES the input path. It is a one-way
 *     digest, not an encoding.
 *   - Two different project paths carrying the SAME cohort label produce
 *     DIFFERENT refs, because the path is part of the digest input.
 *   - The result is stable for a given (salt, path) pair, so the same project
 *     correlates across processes and restarts.
 *
 * What it does NOT guarantee, stated plainly rather than overclaimed: this is a
 * PSEUDONYM, not an anonymous value, and it is not "irreversible" in the sense
 * that matters. With the PUBLIC {@link DEFAULT_LINEAGE_SALT} the digest input is
 * fully known except for the path, and real paths are low entropy, so a holder
 * of an export can CONFIRM a guessed path by re-hashing candidates and matching
 * the ref. Setting {@link LINEAGE_SALT_ENV} to a private per-install value
 * restores guess-resistance and makes refs unlinkable across installs. The
 * algorithm is deliberately left alone here: deriving and persisting a
 * per-install salt needs init-path I/O, which AGENTS.md invariant 1 forbids, so
 * it belongs with #2047.
 *
 * SCOPE of the AC3 claim: `cohortRef` and `worktreeRef` are computed only when a
 * caller supplies `cohortLabel` / `worktreeId` to `initObservability`. The sole
 * production caller (`src/index.ts:732-744`) supplies neither, so both are
 * `undefined` in every real run today; AC3 is asserted at unit level against
 * this API, not against a production emission path.
 *
 * @param absolutePath - Value to pseudonymize. Never stored or echoed.
 * @param salt - Salt from {@link resolveLineageSalt}.
 */
export function pseudonymousRef(absolutePath: string, salt: string): string {
	return createHash('sha256')
		.update(salt + LINEAGE_SEPARATOR + absolutePath, 'utf8')
		.digest('hex')
		.slice(0, PSEUDONYMOUS_REF_LENGTH);
}

/**
 * Produce a pseudonymous reference for a session id (#2044).
 *
 * Same construction and salt handling as {@link pseudonymousRef}, applied to the
 * opaque session id string: `sha256(salt + NUL + sessionId)`, truncated to
 * {@link PSEUDONYMOUS_REF_LENGTH} hex chars. Used by the learning-health alarm
 * registry so persisted health state and telemetry payloads never carry raw
 * session ids (issue #2044 item 10).
 *
 * Contract note: session ids are operator-known opaque strings, not secrets;
 * the pseudonym prevents cross-install linkage exactly as `pseudonymousRef`
 * does for paths. With the public default salt a holder of a payload can
 * CONFIRM a guessed session id by re-hashing; a private
 * {@link LINEAGE_SALT_ENV} restores guess-resistance. This module stays pure —
 * no I/O; the salt is read at call time.
 */
export function pseudonymousSessionRef(
	sessionId: string,
	salt: string = resolveLineageSalt(),
): string {
	return pseudonymousRef(sessionId, salt);
}
