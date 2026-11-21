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
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';

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
	// First use: create-only. EEXIST (a concurrent first-use writer won) →
	// read and validate the winner.
	const salt = randomBytes(SALT_BYTES);
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		const fd = fs.openSync(target, 'wx', 0o600);
		try {
			fs.writeFileSync(fd, `${salt.toString('hex')}\n`, 'utf8');
		} finally {
			fs.closeSync(fd);
		}
		return salt;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw new ReplayIdentityUnavailableError(
				`cannot create salt: ${(error as Error).message}`,
			);
		}
		const winner = fs.readFileSync(target, 'utf8').trim();
		if (!isValidSaltHex(winner)) {
			throw new ReplayIdentityUnavailableError(
				'concurrently created salt is corrupt',
			);
		}
		return Buffer.from(winner, 'hex');
	}
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
	} catch {
		return null;
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
