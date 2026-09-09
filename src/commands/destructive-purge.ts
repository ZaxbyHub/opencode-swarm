/**
 * Issue #2527 / #2508: the shared two-step destructive-purge confirmation
 * primitive (preview + confirm_token → exact-token execution).
 *
 * Contract (frozen by check C8 and the destructive-purge-2527 unit suite):
 *  - `previewDestructivePurge` is a side-effect-free preview (counts, exact
 *    option label, the confirmation the operator must echo);
 *  - `issueConfirmToken` records a token-addressed pending purge keyed by a
 *    digest over the candidate SET (sorted absolute paths + kind) and
 *    returns the confirm token (15-minute TTL).  Each token has its own
 *    record, so an authorization issued by one command cannot clobber a
 *    different command's authorization;
 *  - `executeDestructivePurge` re-derives the CURRENT scope digest and
 *    passes only on exact token match AND digest match AND fresh TTL — so
 *    replay after the candidate set changes (a lane added, removed, or the
 *    scope re-derived differently) is rejected by construction, and the
 *    token is single-use (the pending record is consumed on execution; a
 *    second execution is rejected with "no pending purge").
 *  - TTL expiry: an expired pending record is treated as absent on read
 *    (silent).  Claimed records left by an interrupted process are
 *    non-executable and are removed only by the conservative TTL cleanup;
 *    malformed or future-dated residue is preserved (fail closed).
 *  - Scope-of-execution: the executor deletes ONLY the recorded candidate
 *    paths. The primitive confirms operator intent; CALLERS own scoping —
 *    `/swarm reset-session` (and #2508's `/swarm close` when it adopts
 *    this) must only construct candidate sets from ownership-gated,
 *    base-scoped directories.
 */
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateSwarmPath } from '../hooks/utils';
import { atomicWriteSwarmFileSync } from '../utils/atomic-write';
import * as logger from '../utils/logger.js';

// validateSwarmPath joins `.swarm/` itself — keep this filename-only.
const PENDING_PURGE_TTL_MS = 15 * 60 * 1000;
const TOKEN_PATTERN = /^[0-9a-f]{24}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const PENDING_PURGE_PATTERN = /^pending-purge-[0-9a-f]{24}\.json$/;
const CLAIMED_PURGE_PATTERN =
	/^pending-purge-[0-9a-f]{24}-[0-9a-f]{64}\.claimed\.json$/;

export interface PurgeCandidate {
	path: string;
	reason: string;
}

export interface PurgePlan {
	previewLines: string[];
	counts: { total: number };
	optionLabel: string;
	confirmToken: string;
	candidates: PurgeCandidate[];
}

export interface PurgeExecution {
	ok: boolean;
	reason?: string;
	purged?: string[];
}

/**
 * A claimed authorization is an opaque capability for one exact purge
 * record. Callers must verify it against their post-lock inventory before
 * consuming it; the claim path is included only so the capability can be
 * consumed without scanning or guessing at filesystem state.
 */
export interface ClaimedDestructivePurge {
	readonly token: string;
	readonly scopeDigest: string;
	readonly createdAt: number;
	readonly claimPath: string;
}

export interface PurgeClaimResult {
	ok: boolean;
	reason?: string;
	claim?: ClaimedDestructivePurge;
}

interface PendingPurgeRecord {
	schemaVersion: 1;
	scopeDigest: string;
	confirmToken: string;
	createdAt: number;
}

export const _internals = {
	readFileSync: fs.readFileSync as (p: string, enc: BufferEncoding) => string,
	rmSync: fs.rmSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	renameSync: fs.renameSync.bind(fs),
	atomicWriteSwarmFileSync,
	now: (): number => Date.now(),
	randomBytes,
	scopeDigest,
};

function pendingPath(directory: string, token: string): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new Error('invalid destructive-purge confirmation token');
	}
	return validateSwarmPath(directory, `pending-purge-${token}.json`);
}

function claimedPath(directory: string, token: string, digest: string): string {
	if (!TOKEN_PATTERN.test(token) || !DIGEST_PATTERN.test(digest)) {
		throw new Error('invalid destructive-purge claim identity');
	}
	return validateSwarmPath(
		directory,
		`pending-purge-${token}-${digest}.claimed.json`,
	);
}

/**
 * Resolve the effective candidate set: the single target, or the explicit set.
 * #2508: an explicit `kind` (e.g. 'swarm-close') binds into the scope digest
 * so a token minted by one destructive surface cannot be consumed by another
 * with the same candidate paths.
 */
function resolveCandidates(
	scopeTarget: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): { kind: string; candidates: PurgeCandidate[] } {
	if (extra?.candidates && extra.candidates.length > 0) {
		return { kind: extra.kind ?? 'set', candidates: extra.candidates };
	}
	return {
		kind: extra?.kind ?? 'single',
		candidates: [{ path: scopeTarget, reason: 'operator-requested' }],
	};
}

function scopeDigest(kind: string, candidates: PurgeCandidate[]): string {
	const paths = candidates.map((c) => {
		const resolved = path.resolve(c.path);
		// #2508 hardening: NUL or newline inside a path would be indistinguishable
		// from this digest's own separators. POSIX allows both in filenames, so
		// reject instead of hashing an ambiguous byte stream.
		if (resolved.includes('\0') || resolved.includes('\n')) {
			throw new Error(
				`Purge candidate path contains a NUL or newline separator character and cannot be scope-bound: ${JSON.stringify(resolved)}`,
			);
		}
		return resolved;
	});
	const sorted = paths.sort().join('\n');
	return createHash('sha256').update(`${kind}\0${sorted}`).digest('hex');
}

function mintToken(digest: string): string {
	return createHash('sha256')
		.update(`${digest}:${_internals.randomBytes(16).toString('hex')}`)
		.digest('hex')
		.slice(0, 24);
}

function parsePendingRecord(
	parsed: unknown,
	token: string,
	options?: { enforceTtl?: boolean },
): PendingPurgeRecord | null {
	if (
		!parsed ||
		typeof parsed !== 'object' ||
		(parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
		typeof (parsed as { scopeDigest?: unknown }).scopeDigest !== 'string' ||
		!DIGEST_PATTERN.test((parsed as { scopeDigest: string }).scopeDigest) ||
		(parsed as { confirmToken?: unknown }).confirmToken !== token ||
		typeof (parsed as { createdAt?: unknown }).createdAt !== 'number'
	) {
		return null;
	}
	const record = parsed as PendingPurgeRecord;
	// TTL expiry is silent: an expired record reads as absent. A future-dated
	// record beyond the clock-skew allowance is corrupt/hostile and also reads
	// as absent.
	if (!Number.isFinite(record.createdAt)) return null;
	if (
		options?.enforceTtl !== false &&
		record.createdAt > _internals.now() + 60_000
	)
		return null;
	if (
		options?.enforceTtl !== false &&
		_internals.now() - record.createdAt > PENDING_PURGE_TTL_MS
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		scopeDigest: record.scopeDigest,
		confirmToken: record.confirmToken,
		createdAt: record.createdAt,
	};
}

function readPending(
	directory: string,
	token: string,
): PendingPurgeRecord | null {
	try {
		const raw = _internals.readFileSync(pendingPath(directory, token), 'utf-8');
		return parsePendingRecord(JSON.parse(raw), token);
	} catch {
		return null;
	}
}

/**
 * Remove only valid, expired claims.  Claims are never read as executable
 * authorizations, and malformed/future-dated records stay put for diagnosis.
 */
export function cleanupExpiredDestructivePurgeClaims(
	directory: string,
): number {
	let removed = 0;
	const swarmDir = path.dirname(pendingPath(directory, '0'.repeat(24)));
	let entries: string[];
	try {
		entries = fs.readdirSync(swarmDir);
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const claimMatch = CLAIMED_PURGE_PATTERN.test(entry)
			? /^pending-purge-([0-9a-f]{24})-([0-9a-f]{64})\.claimed\.json$/.exec(
					entry,
				)
			: null;
		const pendingMatch = PENDING_PURGE_PATTERN.test(entry)
			? /^pending-purge-([0-9a-f]{24})\.json$/.exec(entry)
			: null;
		if (!claimMatch && !pendingMatch) continue;
		const token = claimMatch?.[1] ?? pendingMatch?.[1];
		if (!token) continue;
		const digest = claimMatch?.[2];
		let record: PendingPurgeRecord | null = null;
		try {
			record = parsePendingRecord(
				JSON.parse(
					_internals.readFileSync(path.join(swarmDir, entry), 'utf-8'),
				),
				token,
				{ enforceTtl: false },
			);
		} catch {
			// Preserve malformed residue. Cleanup must fail closed.
			continue;
		}
		if (!record) continue;
		if (digest && record.scopeDigest !== digest) continue;
		if (_internals.now() - record.createdAt <= PENDING_PURGE_TTL_MS) continue;
		try {
			const target = digest
				? claimedPath(directory, token, digest)
				: pendingPath(directory, token);
			_internals.rmSync(target, { force: true });
			removed += 1;
		} catch {
			// Best-effort cleanup; retain residue if the filesystem refuses it.
		}
	}
	return removed;
}

function writePending(directory: string, record: PendingPurgeRecord): void {
	_internals.atomicWriteSwarmFileSync(
		pendingPath(directory, record.confirmToken),
		JSON.stringify(record, null, 2),
	);
}

function claimPending(
	directory: string,
	token: string,
	digest: string,
): { record: PendingPurgeRecord; path: string } | null {
	let source: string;
	let destination: string;
	try {
		source = pendingPath(directory, token);
		destination = claimedPath(directory, token, digest);
	} catch {
		return null;
	}
	// A pre-existing claim is non-executable residue. Never replace it: a
	// second consumer must not be able to steal or overwrite the first claim.
	if (_internals.existsSync(destination)) return null;
	try {
		// Same-directory rename is the atomic single-winner boundary on the
		// supported filesystems. The loser observes a missing source.
		_internals.renameSync(source, destination);
	} catch {
		return null;
	}
	try {
		const record = parsePendingRecord(
			JSON.parse(_internals.readFileSync(destination, 'utf-8')),
			token,
		);
		if (!record || record.scopeDigest !== digest) return null;
		return { record, path: destination };
	} catch {
		return null;
	}
}

function claimFromRecord(
	token: string,
	claim: { record: PendingPurgeRecord; path: string },
): ClaimedDestructivePurge {
	return {
		token,
		scopeDigest: claim.record.scopeDigest,
		createdAt: claim.record.createdAt,
		claimPath: claim.path,
	};
}

function readClaimedAuthorization(
	projectRoot: string,
	claim: ClaimedDestructivePurge,
): PendingPurgeRecord | null {
	if (
		!TOKEN_PATTERN.test(claim.token) ||
		!DIGEST_PATTERN.test(claim.scopeDigest) ||
		!Number.isFinite(claim.createdAt)
	)
		return null;
	let expectedPath: string;
	try {
		expectedPath = claimedPath(projectRoot, claim.token, claim.scopeDigest);
	} catch {
		return null;
	}
	if (path.resolve(claim.claimPath) !== path.resolve(expectedPath)) return null;
	try {
		const record = parsePendingRecord(
			JSON.parse(_internals.readFileSync(expectedPath, 'utf-8')),
			claim.token,
		);
		if (
			!record ||
			record.scopeDigest !== claim.scopeDigest ||
			record.createdAt !== claim.createdAt
		)
			return null;
		return record;
	} catch {
		return null;
	}
}

/**
 * Atomically claim an exact token without touching any candidate. This is the
 * authorization-only half used by close/finalize: callers may claim before a
 * lock, then verify the post-lock inventory before consuming the capability.
 */
export function claimDestructivePurge(
	scopeTarget: string,
	projectRoot: string,
	token: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgeClaimResult {
	const pending = readPending(projectRoot, token);
	if (!pending) {
		return {
			ok: false,
			reason:
				'no pending purge for this scope (expired, overwritten, already claimed, or malformed)',
		};
	}
	const scope = resolveCandidates(scopeTarget, extra);
	const digest = scopeDigest(scope.kind, scope.candidates);
	if (pending.scopeDigest !== digest) {
		return {
			ok: false,
			reason:
				'purge scope changed since the token was issued — re-run the preview and confirm the new token',
		};
	}
	const claimed = claimPending(projectRoot, token, digest);
	if (!claimed) {
		return {
			ok: false,
			reason:
				'no pending purge for this scope (already claimed, expired, overwritten, or malformed)',
		};
	}
	// Re-derive immediately after the rename. A concurrent inventory change
	// leaves the non-executable claim as recovery evidence and performs no
	// destructive action.
	const currentScope = resolveCandidates(scopeTarget, extra);
	if (scopeDigest(currentScope.kind, currentScope.candidates) !== digest) {
		return {
			ok: false,
			reason:
				'purge scope changed while claiming authorization — re-run the preview and confirm the new token',
		};
	}
	return { ok: true, claim: claimFromRecord(token, claimed) };
}

/**
 * Verify a claimed authorization against a caller's current inventory. This
 * is intentionally side-effect-free and must be run after the caller's lock
 * is acquired. It requires exact token/digest/record identity and a fresh TTL.
 */
export function verifyDestructivePurgeClaim(
	claim: ClaimedDestructivePurge,
	scopeTarget: string,
	projectRoot: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgeClaimResult {
	const record = readClaimedAuthorization(projectRoot, claim);
	if (!record) {
		return {
			ok: false,
			reason: 'claimed purge authorization is missing, stale, or malformed',
		};
	}
	const scope = resolveCandidates(scopeTarget, extra);
	if (scopeDigest(scope.kind, scope.candidates) !== claim.scopeDigest) {
		return {
			ok: false,
			reason:
				'purge scope changed after authorization claim — no destructive action was authorized',
		};
	}
	return { ok: true, claim: { ...claim, createdAt: record.createdAt } };
}

/**
 * Consume a previously verified claim exactly once without deleting any
 * candidate. A non-forced unlink is the single-use boundary: concurrent
 * consumers race on the same claim file and only one can remove it.
 */
export function consumeDestructivePurgeClaim(
	claim: ClaimedDestructivePurge,
	projectRoot: string,
): PurgeClaimResult {
	if (!readClaimedAuthorization(projectRoot, claim)) {
		return {
			ok: false,
			reason: 'claimed purge authorization is missing, stale, or malformed',
		};
	}
	try {
		_internals.rmSync(claim.claimPath, { force: false });
		return { ok: true };
	} catch {
		return {
			ok: false,
			reason: 'claimed purge authorization could not be consumed',
		};
	}
}

/**
 * Side-effect-free preview: what would be purged, the counts, the exact
 * option label the operator must echo, and the confirm token to use.
 * (The token returned here is informational; `issueConfirmToken` is what
 * arms it — keeping preview strictly read-only lets callers preview freely.)
 */
export function previewDestructivePurge(
	scopeTarget: string,
	projectRoot: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgePlan {
	const scope = resolveCandidates(scopeTarget, extra);
	const previewLines = [
		`Destructive purge preview (${scope.candidates.length} candidate(s)) for ${projectRoot}:`,
		...scope.candidates.map((c) => `  - ${c.path} (${c.reason})`),
		'Uncommitted work inside these directories will be DESTROYED.',
	];
	return {
		previewLines,
		counts: { total: scope.candidates.length },
		optionLabel: `--confirm=<token>`,
		// Preview shows the token shape only; arming happens in issueConfirmToken.
		confirmToken: '<run again to receive your confirm token>',
		candidates: scope.candidates,
	};
}

/**
 * Arm a pending purge for the scope and return the confirm token. The
 * Every issuance gets a token-addressed record. This prevents independent
 * close/reset operations from clobbering one another's authorization.
 */
export function issueConfirmToken(
	scopeTarget: string,
	projectRoot: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): string {
	cleanupExpiredDestructivePurgeClaims(projectRoot);
	const scope = resolveCandidates(scopeTarget, extra);
	const digest = scopeDigest(scope.kind, scope.candidates);
	const token = mintToken(digest);
	writePending(projectRoot, {
		schemaVersion: 1,
		scopeDigest: digest,
		confirmToken: token,
		createdAt: _internals.now(),
	});
	return token;
}

/**
 * Validate a pending confirm token WITHOUT deleting anything (#2508): the
 * same pending-present / exact-token / digest-match / fresh-TTL checks as
 * `executeDestructivePurge`, with the same single-use consumption of the
 * pending record. Callers that own non-deletion destructive work (e.g.
 * `/swarm close`'s clean + align stages) use this to gate their own
 * pipeline on the operator's exact confirmation.
 */
export function consumeConfirmToken(
	scopeTarget: string,
	projectRoot: string,
	token: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgeExecution {
	const verdict = verifyPendingConfirmToken(
		scopeTarget,
		projectRoot,
		token,
		extra,
	);
	if (!verdict.ok) return verdict;
	try {
		_internals.rmSync(pendingPath(projectRoot), { force: true });
	} catch (error) {
		logger.log(
			`[destructive-purge] could not consume pending record: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return { ok: true };
}

/** Shared validation core: every check except consumption and deletion. */
function verifyPendingConfirmToken(
	scopeTarget: string,
	projectRoot: string,
	token: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgeExecution {
	const claimResult = claimDestructivePurge(
		scopeTarget,
		projectRoot,
		token,
		extra,
	);
	if (!claimResult.ok || !claimResult.claim) {
		return {
			ok: false,
			reason: claimResult.reason ?? 'purge authorization rejected',
		};
	}
	const verification = verifyDestructivePurgeClaim(
		claimResult.claim,
		scopeTarget,
		projectRoot,
		extra,
	);
	if (!verification.ok) {
		return {
			ok: false,
			reason: verification.reason ?? 'purge authorization verification failed',
		};
	}
	return { ok: true };
}

/**
 * Execute the pending purge under the exact token. Re-derives the CURRENT
 * scope digest: token match AND digest match AND fresh TTL required; the
 * record is consumed on success (single use). Deletes ONLY the recorded
 * candidate paths.
 */
export function executeDestructivePurge(
	scopeTarget: string,
	projectRoot: string,
	token: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): PurgeExecution {
	const verdict = verifyPendingConfirmToken(
		scopeTarget,
		projectRoot,
		token,
		extra,
	);
	if (!verdict.ok) return verdict;
	const { candidates } = resolveCandidates(scopeTarget, extra);
	const purged: string[] = [];
	for (const candidate of candidates) {
		if (!_internals.existsSync(candidate.path)) continue;
		try {
			_internals.rmSync(candidate.path, { recursive: true, force: true });
			purged.push(candidate.path);
		} catch (error) {
			// Consume the record even on partial failure: the operator
			// confirmed this exact set; re-running the two-step is the honest
			// recovery for whatever survived.
			return {
				ok: false,
				reason: `candidate ${candidate.path} could not be purged: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}
	const consumed = consumeDestructivePurgeClaim(claimResult.claim, projectRoot);
	if (!consumed.ok) {
		logger.log(
			`[destructive-purge] could not consume pending record: ${consumed.reason ?? 'unknown error'}`,
		);
	}
	return { ok: true, purged };
}
