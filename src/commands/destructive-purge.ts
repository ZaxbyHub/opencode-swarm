/**
 * Issue #2527 / #2508: the shared two-step destructive-purge confirmation
 * primitive (preview + confirm_token → exact-token execution).
 *
 * Contract (frozen by check C8 and the destructive-purge-2527 unit suite):
 *  - `previewDestructivePurge` is a side-effect-free preview (counts, exact
 *    option label, the confirmation the operator must echo);
 *  - `issueConfirmToken` records a single-slot pending purge keyed by a
 *    digest over the candidate SET (sorted absolute paths + kind) and
 *    returns the confirm token (15-minute TTL);
 *  - `executeDestructivePurge` re-derives the CURRENT scope digest and
 *    passes only on exact token match AND digest match AND fresh TTL — so
 *    replay after the candidate set changes (a lane added, removed, or the
 *    scope re-derived differently) is rejected by construction, and the
 *    token is single-use (the pending record is consumed on execution; a
 *    second execution is rejected with "no pending purge").
 *  - TTL expiry: an expired pending record is treated as absent on read
 *    (silent); every new issuance overwrites the single slot — the
 *    overwritten token can never execute (it is rejected with "confirm
 *    token mismatch"; a single-slot store cannot distinguish generations,
 *    but rejection is guaranteed either way).
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
const PENDING_PURGE_PATH = 'pending-purge.json';
const PENDING_PURGE_TTL_MS = 15 * 60 * 1000;

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
	atomicWriteSwarmFileSync,
	now: (): number => Date.now(),
	randomBytes,
};

function pendingPath(directory: string): string {
	return validateSwarmPath(directory, PENDING_PURGE_PATH);
}

/** Resolve the effective candidate set: the single target, or the explicit set. */
function resolveCandidates(
	scopeTarget: string,
	extra?: { candidates?: PurgeCandidate[] },
): { kind: string; candidates: PurgeCandidate[] } {
	if (extra?.candidates && extra.candidates.length > 0) {
		return { kind: 'set', candidates: extra.candidates };
	}
	return {
		kind: 'single',
		candidates: [{ path: scopeTarget, reason: 'operator-requested' }],
	};
}

function scopeDigest(kind: string, candidates: PurgeCandidate[]): string {
	const paths = candidates
		.map((c) => path.resolve(c.path))
		.sort()
		.join('\n');
	return createHash('sha256').update(`${kind}\0${paths}`).digest('hex');
}

function mintToken(digest: string): string {
	return createHash('sha256')
		.update(`${digest}:${_internals.randomBytes(16).toString('hex')}`)
		.digest('hex')
		.slice(0, 24);
}

function readPending(directory: string): PendingPurgeRecord | null {
	try {
		const raw = _internals.readFileSync(pendingPath(directory), 'utf-8');
		const parsed = JSON.parse(raw) as Partial<PendingPurgeRecord>;
		if (
			!parsed ||
			parsed.schemaVersion !== 1 ||
			typeof parsed.scopeDigest !== 'string' ||
			typeof parsed.confirmToken !== 'string' ||
			typeof parsed.createdAt !== 'number'
		) {
			return null;
		}
		// TTL expiry is silent: an expired record reads as absent.
		if (_internals.now() - parsed.createdAt > PENDING_PURGE_TTL_MS) return null;
		return {
			schemaVersion: 1,
			scopeDigest: parsed.scopeDigest,
			confirmToken: parsed.confirmToken,
			createdAt: parsed.createdAt,
		};
	} catch {
		return null;
	}
}

function writePending(directory: string, record: PendingPurgeRecord): void {
	_internals.atomicWriteSwarmFileSync(
		pendingPath(directory),
		JSON.stringify(record, null, 2),
	);
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
	const digest = scopeDigest(scope.kind, scope.candidates);
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
 * single-slot record is overwritten by every new issuance (the previous
 * token stops working — "no pending purge for this scope").
 */
export function issueConfirmToken(
	scopeTarget: string,
	projectRoot: string,
	extra?: { kind?: string; candidates?: PurgeCandidate[] },
): string {
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
	const pending = readPending(projectRoot);
	if (!pending) {
		return { ok: false, reason: 'no pending purge for this scope (expired, overwritten, or already executed)' };
	}
	const scope = resolveCandidates(scopeTarget, extra);
	const digest = scopeDigest(scope.kind, scope.candidates);
	if (pending.confirmToken !== token) {
		return { ok: false, reason: 'confirm token mismatch' };
	}
	if (pending.scopeDigest !== digest) {
		return {
			ok: false,
			reason: 'purge scope changed since the token was issued — re-run the preview and confirm the new token',
		};
	}
	const purged: string[] = [];
	for (const candidate of scope.candidates) {
		if (!_internals.existsSync(candidate.path)) continue;
		try {
			_internals.rmSync(candidate.path, { recursive: true, force: true });
			purged.push(candidate.path);
		} catch (error) {
			// Consume the record even on partial failure: the operator
			// confirmed this exact set; re-running the two-step is the honest
			// recovery for whatever survived.
			try {
				_internals.rmSync(pendingPath(projectRoot), { force: true });
			} catch {
				// Best-effort.
			}
			return {
				ok: false,
				reason: `candidate ${candidate.path} could not be purged: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
	}
	try {
		_internals.rmSync(pendingPath(projectRoot), { force: true });
	} catch (error) {
		logger.log(
			`[destructive-purge] could not consume pending record: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return { ok: true, purged };
}
