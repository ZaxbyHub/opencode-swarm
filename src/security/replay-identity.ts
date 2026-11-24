/**
 * #3844 replay identity: a salted HMAC-SHA-256 fingerprint over the RAW
 * canonical payload of a persisted artifact, kept in a SIDECAR file so the
 * durable artifacts themselves never carry raw credential text.
 *
 * Why two identities: redaction-before-persistence means an identical raw
 * retry no longer compares equal to the stored (redacted) bytes, while two
 * DIFFERENT raw secrets of one family redact to the same placeholder. The
 * fingerprint preserves the distinction: identical raw input → identical
 * fingerprint (dedup), any different raw input → different fingerprint
 * (conflict) — including two same-family tokens.
 *
 * Salt lifecycle (#3844 round-4 contract): 32 random bytes, generated ONCE
 * per project root at `.swarm/pr-review/replay-identity.salt` with a
 * create-only (`wx`) write; EEXIST → read + validate the winner (64-hex) and
 * USE it, never overwrite. Missing → generate; corrupt/unreadable → FAIL
 * CLOSED (fingerprinting throws; callers treat every comparison as a
 * conflict and refuse first artifact creation). The security property is the
 * SECRET KEY: without the project-local salt, stored fingerprints neither
 * correlate across projects nor brute-force arbitrary review prose. No
 * one-wayness claim is made about the digest itself. POSIX mode bits are
 * advisory; on Windows the file inherits the `.swarm` directory ACLs.
 */

import { createHmac, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	atomicWriteSwarmFileSync,
	createExclusiveSwarmFileSync,
} from '../utils/atomic-write';

const DOMAIN = 'swarm-pr-review-replay-identity-v1';
const SALT_BYTES = 32;

export class ReplayIdentityUnavailableError extends Error {
	constructor(reason: string) {
		super(`replay identity unavailable: ${reason}`);
		this.name = 'ReplayIdentityUnavailableError';
	}
}

function saltPath(directory: string): string {
	return path.join(directory, '.swarm', 'pr-review', 'replay-identity.salt');
}

/** Test seam for simulating the create-race (first read misses, wx then
 * collides with a concurrent winner). Production defaults unchanged. */
export const _internals = {
	readSaltFileSync: (target: string): string => fs.readFileSync(target, 'utf8'),
};

function isValidSaltHex(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

/**
 * Load the project salt, creating it ONCE on first use (create-only 'wx';
 * on a lost first-use race the existing winner is validated and used).
 * Throws ReplayIdentityUnavailableError when the salt is corrupt or
 * unreadable — callers fail closed.
 */
export function loadOrCreateReplayIdentitySalt(directory: string): Buffer {
	const target = saltPath(directory);
	try {
		const existing = _internals.readSaltFileSync(target).trim();
		if (isValidSaltHex(existing)) {
			return Buffer.from(existing, 'hex');
		}
		throw new ReplayIdentityUnavailableError('salt file is corrupt');
	} catch (error) {
		if (
			error instanceof ReplayIdentityUnavailableError ||
			(error as NodeJS.ErrnoException).code !== 'ENOENT'
		) {
			throw error;
		}
	}
	// First use: create-only. The content is published by LINKING a complete,
	// fsync'd temp file into place (createExclusiveSwarmFileSync), so the
	// target path never exists in a partial state: a reader either sees no
	// file yet or sees the whole salt. A lost race (EEXIST) means a
	// concurrent first-use writer won, so its salt is read and validated.
	const salt = randomBytes(SALT_BYTES);
	let created = false;
	try {
		created = createExclusiveSwarmFileSync(
			target,
			`${salt.toString('hex')}\n`,
			{
				mode: 0o600,
			},
		);
	} catch (error) {
		throw new ReplayIdentityUnavailableError(
			`cannot create salt: ${(error as Error).message}`,
		);
	}
	if (created) return salt;
	const winner = _internals.readSaltFileSync(target).trim();
	if (!isValidSaltHex(winner)) {
		throw new ReplayIdentityUnavailableError(
			'concurrently created salt is corrupt',
		);
	}
	return Buffer.from(winner, 'hex');
}

/**
 * Domain-separated HMAC-SHA-256 fingerprint of a raw canonical payload.
 * Throws ReplayIdentityUnavailableError when the salt cannot be established.
 */
export function replayFingerprint(
	directory: string,
	rawPayload: string,
): string {
	const salt = loadOrCreateReplayIdentitySalt(directory);
	return createHmac('sha256', salt)
		.update(`${DOMAIN}\u0000${rawPayload}`)
		.digest('hex');
}

export interface ReplayIdentitySidecar {
	schema_version: 1;
	/** Non-secret identity keys (e.g. boundary name) -> raw-payload HMAC. */
	fingerprints: Record<string, string>;
}

export function replaySidecarPath(directory: string, runId: string): string {
	return path.join(
		directory,
		'.swarm',
		'pr-review',
		runId,
		'replay-identity.json',
	);
}

/**
 * Read the sidecar for a run. Returns null when absent (legacy pre-#3844 run,
 * or a never-written sidecar — callers fail closed on comparisons they need
 * it for). Throws ReplayIdentityUnavailableError only for a corrupt file.
 */
export function readReplayIdentitySidecar(
	directory: string,
	runId: string,
): ReplayIdentitySidecar | null {
	const target = replaySidecarPath(directory, runId);
	let text: string;
	try {
		text = fs.readFileSync(target, 'utf8');
	} catch (error) {
		// ONLY an absent sidecar is "no sidecar". An unreadable one (a
		// transient I/O failure, a permission problem) must NOT be treated as
		// absence: a write would then rewrite the sidecar with only its own
		// key and silently drop every other boundary's identity.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw new ReplayIdentityUnavailableError(
			`sidecar could not be read: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ReplayIdentityUnavailableError('sidecar is not valid JSON');
	}
	const record = parsed as Partial<ReplayIdentitySidecar>;
	if (
		record.schema_version !== 1 ||
		typeof record.fingerprints !== 'object' ||
		record.fingerprints === null
	) {
		throw new ReplayIdentityUnavailableError('sidecar has an invalid shape');
	}
	return record as ReplayIdentitySidecar;
}

/**
 * Persist a fingerprint under a non-secret key. Sidecar-first ordering: the
 * artifact write happens AFTER this, so artifact success implies the sidecar
 * exists; a sidecar write failure aborts the whole operation (no retry gets
 * stranded without raw-replay identity).
 */
export function writeReplayIdentityFingerprint(
	directory: string,
	runId: string,
	key: string,
	fingerprint: string,
): void {
	const target = replaySidecarPath(directory, runId);
	let sidecar: ReplayIdentitySidecar;
	try {
		const existing = readReplayIdentitySidecar(directory, runId);
		sidecar = existing ?? { schema_version: 1, fingerprints: {} };
	} catch (error) {
		if (error instanceof ReplayIdentityUnavailableError) {
			// corrupt sidecar: fail closed rather than overwrite
			throw error;
		}
		throw error;
	}
	sidecar.fingerprints[key] = fingerprint;
	fs.mkdirSync(path.dirname(target), { recursive: true });
	atomicWriteSwarmFileSync(target, JSON.stringify(sidecar, null, 2));
}

/**
 * Restore a sidecar key to a PREVIOUS value — the rollback counterpart of
 * {@link writeReplayIdentityFingerprint}.
 *
 * The sidecar-first ordering means the identity lands BEFORE the artifact
 * it describes. If the artifact write then fails, the sidecar would keep
 * claiming an identity the artifact never committed, and the next identical
 * retry would read that identity as "already persisted" and silently skip
 * the write — dropping the new content while reporting success. The caller
 * therefore rolls the key back to the value it held before the write.
 *
 * `previous === null` means the key did not exist: the rollback REMOVES it.
 * A MISSING sidecar is a no-op (there is nothing to restore); an UNREADABLE
 * sidecar (a transient I/O failure, not ENOENT) throws — treating it as
 * absence would silently leave the new identity in place, which is exactly
 * the state the rollback exists to remove. A CORRUPT sidecar throws as well
 * (fail closed — the caller must not overwrite it).
 *
 * If the restore WRITE fails, the sidecar is left in place: discarding it
 * would throw away the identity of every OTHER committed boundary (their
 * identical retries would then be refused). A stale key is fail-closed
 * instead — the replay decision also cross-checks the PERSISTED ROWS, so a
 * sidecar that still claims an uncommitted payload cannot make the next
 * identical retry drop that content silently.
 */
export function restoreReplayIdentityFingerprint(
	directory: string,
	runId: string,
	key: string,
	previous: string | null,
): void {
	const target = replaySidecarPath(directory, runId);
	let text: string;
	try {
		text = fs.readFileSync(target, 'utf8');
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return; // no sidecar — nothing was written
		throw error; // unreadable — fail closed rather than treat as absence
	}
	let sidecar: ReplayIdentitySidecar;
	try {
		const parsed = JSON.parse(text) as Partial<ReplayIdentitySidecar>;
		if (
			parsed.schema_version !== 1 ||
			typeof parsed.fingerprints !== 'object' ||
			parsed.fingerprints === null
		) {
			throw new ReplayIdentityUnavailableError('sidecar is not valid JSON');
		}
		sidecar = parsed as ReplayIdentitySidecar;
	} catch (error) {
		if (error instanceof ReplayIdentityUnavailableError) throw error;
		throw new ReplayIdentityUnavailableError(
			`sidecar could not be parsed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	if (previous === null) {
		delete sidecar.fingerprints[key];
	} else {
		sidecar.fingerprints[key] = previous;
	}
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		atomicWriteSwarmFileSync(target, JSON.stringify(sidecar, null, 2));
	} catch (error) {
		// The restore did not land. The sidecar is NOT discarded: that
		// would throw away the identities of every other committed
		// boundary (their identical retries would then be refused). A
		// stale key is fail-closed instead — the replay decision also
		// cross-checks the ARTIFACT content, so a sidecar that claims an
		// uncommitted payload cannot make the next retry drop it silently.
		throw error;
	}
}

/**
 * #3844 round-5 (plan-critic Critical): claim-once identity for
 * create-only artifacts. The shared sidecar map cannot express "first writer
 * wins" — a losing concurrent writer could overwrite the winner's
 * fingerprint key and then validate its own raw payload against that losing
 * fingerprint. A claim file written with create-only 'wx' semantics is
 * immutable for the artifact's life: the FIRST writer's fingerprint owns the
 * identity, every later writer reads and compares against it.
 */
export function replayIdentityClaimPath(
	directory: string,
	runId: string,
	key: string,
): string {
	return path.join(
		directory,
		'.swarm',
		'pr-review',
		runId,
		`replay-identity.${key}.claim`,
	);
}

/**
 * Read a claim file. Returns null when absent. Throws
 * ReplayIdentityUnavailableError when present but corrupt (not 64-hex) —
 * callers fail closed on comparisons they need it for.
 */
export function readReplayIdentityClaim(
	directory: string,
	runId: string,
	key: string,
): string | null {
	const target = replayIdentityClaimPath(directory, runId, key);
	let text: string;
	try {
		text = fs.readFileSync(target, 'utf8');
	} catch {
		return null;
	}
	const claim = text.trim();
	if (!/^[0-9a-f]{64}$/.test(claim)) {
		throw new ReplayIdentityUnavailableError('identity claim is corrupt');
	}
	return claim;
}

export interface ReplayIdentityClaimResult {
	/** True when THIS caller created the claim (it owns the identity). */
	claimed: boolean;
	/** The fingerprint that owns the identity — the prior winner's on EEXIST,
	 * the caller's own when claimed. */
	effective: string;
}

/**
 * Atomically claim a replay-identity key for a create-only artifact: the
 * first writer's fingerprint is written with 'wx' and never overwritten. On
 * a lost race the existing winner's fingerprint is returned so the caller
 * can compare (identical raw → proceed; different raw → conflict, before
 * any artifact bytes are written). Corrupt claims throw (fail closed).
 */
export function claimReplayIdentityFingerprint(
	directory: string,
	runId: string,
	key: string,
	fingerprint: string,
): ReplayIdentityClaimResult {
	const target = replayIdentityClaimPath(directory, runId, key);
	try {
		const existing = readReplayIdentityClaim(directory, runId, key);
		if (existing !== null) {
			return { claimed: false, effective: existing };
		}
	} catch (error) {
		if (error instanceof ReplayIdentityUnavailableError) {
			throw error; // corrupt claim — fail closed
		}
		throw error;
	}
	const claimBody = `${fingerprint}\n`;
	let created = false;
	try {
		created = createExclusiveSwarmFileSync(target, claimBody, { mode: 0o600 });
	} catch (error) {
		throw new ReplayIdentityUnavailableError(
			`cannot create identity claim: ${(error as Error).message}`,
		);
	}
	if (created) return { claimed: true, effective: fingerprint };
	const winner = readReplayIdentityClaim(directory, runId, key);
	if (winner === null) {
		throw new ReplayIdentityUnavailableError(
			'identity claim vanished after create race',
		);
	}
	return { claimed: false, effective: winner };
}
