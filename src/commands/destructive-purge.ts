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
import {
	type GitStatusReadResult,
	readGitStatusAsync,
} from './git-status-read.js';
import {
	describeUnreadableCause,
	isOutOfRootRelativePath,
} from './rollback-gate';

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

export const _internals: {
	readFileSync: (p: string, enc: BufferEncoding) => string;
	rmSync: typeof fs.rmSync;
	existsSync: typeof fs.existsSync;
	atomicWriteSwarmFileSync: typeof atomicWriteSwarmFileSync;
	now: () => number;
	randomBytes: typeof randomBytes;
	scopeDigest: typeof scopeDigest;
	/**
	 * #3317: the tracked-dirty status read is async, bounded, and killable
	 * through the shared reader. Legacy sync stubs returning `string | null`
	 * keep their original meaning (#2953's await-tolerant seam contract).
	 */
	runGitStatus: (
		args: readonly string[],
		cwd: string,
	) =>
		| string
		| null
		| GitStatusReadResult
		| Promise<string | null | GitStatusReadResult>;
} = {
	readFileSync: fs.readFileSync as (p: string, enc: BufferEncoding) => string,
	rmSync: fs.rmSync.bind(fs),
	existsSync: fs.existsSync.bind(fs),
	atomicWriteSwarmFileSync,
	now: (): number => Date.now(),
	randomBytes,
	scopeDigest,
	runGitStatus: (args, cwd) => readGitStatusAsync(args, cwd),
};

/**
 * Shared argv for every tracked-dirty measurement (issue #2953): the close
 * gate and the pre-destruction re-check run the identical status command and
 * feed the same parser, so the two measurements parse identically. (Both now
 * route through the shared #3317 reader via their own test seam; equivalence
 * is by convention + review, not a single shared call site.)
 * #3317: `--no-optional-locks` leads the argv — a read-only status must not
 * contend on the index write lock. It is a top-level git option and therefore
 * sits BEFORE the subcommand.
 */
export const GIT_STATUS_ARGS = [
	'--no-optional-locks',
	'status',
	'--porcelain',
] as const;

/**
 * Default bounded status read (#3317: async, killable, through the shared
 * reader). Legacy seam shapes keep their meaning: a sync `string` is stdout,
 * a sync `null` is an unreadable read with NO detail (#2953's await-tolerant
 * stub contract), and a structured failure carries its cause so the
 * pre-destruction refusal can name it (#3317 review PRR-001).
 */
async function runGitStatusRead(
	args: readonly string[],
	cwd: string,
): Promise<
	| { stdout: string; cause?: undefined }
	| {
			cause: { code: string | null; status: number | null; stderrTail: string };
	  }
	| null
> {
	const raw = await _internals.runGitStatus(args, cwd);
	if (typeof raw === 'string') return { stdout: raw };
	if (raw === null) return null;
	if (raw.ok) return { stdout: raw.stdout };
	return {
		cause: { code: raw.code, status: raw.status, stderrTail: raw.stderrTail },
	};
}

/**
 * Parse `git status --porcelain` (newline) output into repo-relative
 * tracked-dirty paths: untracked (`??`) entries are skipped (they survive the
 * align reset), surrounding quotes are stripped, and rename/copy records are
 * split into BOTH sides. R/C may appear in EITHER status column (`R  old ->
 * new` staged, ` R old -> new` worktree renames via `git add -N`) — both
 * columns are tested, never just the first (the codebase porcelain-parser
 * rule from the #2976 rollback-gate review). Sibling module
 * `src/commands/rollback-gate.ts` exports a same-named parser for
 * NUL-terminated `--porcelain -z` output (J1/#2946); the two are deliberately
 * not consolidated in this PR.
 *
 * #3434: `../`-bearing (or absolute) records are excluded from the dirty
 * set and recorded in `excludedOutOfRoot` — the legacy `string[]` export
 * below returns only the in-root paths. The containment predicate itself is
 * the rollback-gate module's `isOutOfRootRelativePath` (single shared
 * definition; the parsers stay separate by design).
 */
export function parseTrackedDirtyPathsWithExclusions(
	statusOutput: string,
): import('./rollback-gate.js').TrackedDirtyParseResult {
	const dirtyPaths: string[] = [];
	const excludedOutOfRoot: string[] = [];
	const push = (candidate: string): void => {
		if (isOutOfRootRelativePath(candidate)) {
			excludedOutOfRoot.push(candidate);
			return;
		}
		dirtyPaths.push(candidate);
	};
	for (const line of statusOutput.split('\n')) {
		if (!line) continue;
		if (line.startsWith('??')) continue;
		const filePath = line.slice(3).trim().replace(/^"|"$/g, '');
		if (!filePath) continue;
		if (/[RC]/.test(line.slice(0, 2)) && filePath.includes(' -> ')) {
			for (const side of filePath.split(' -> ')) {
				const cleaned = side.trim().replace(/^"|"$/g, '');
				if (cleaned) push(cleaned);
			}
		} else {
			push(filePath);
		}
	}
	return { dirtyPaths, excludedOutOfRoot };
}

/**
 * Legacy `string[]` view of the newline-form parser (in-root paths only) —
 * the export existing suites pin. New consumers that need the exclusion
 * diagnostic use `parseTrackedDirtyPathsWithExclusions`.
 */
export function parseTrackedDirtyPaths(statusOutput: string): string[] {
	return parseTrackedDirtyPathsWithExclusions(statusOutput).dirtyPaths;
}

/**
 * Shared tracked-dirty read (issue #2953): GIT_STATUS_ARGS + the shared
 * parser around the default runner (test seam: `_internals.runGitStatus`).
 * The close gate composes the same argv + parser directly through its own
 * long-standing `_closeGateInternals.runGit` seam rather than calling this
 * helper, so its existing #2508 fail-closed tests keep their injection point.
 * #3317: async — the read is bounded and killable, and legacy sync stubs
 * keep working (awaiting a plain value is a no-op).
 * #3434: the ok arm carries `excludedOutOfRoot` so the #2953 re-check
 * compares against the SAME filtered set the operator confirmed.
 */
export async function readTrackedDirtyPaths(directory: string): Promise<
	| {
			ok: true;
			dirtyPaths: string[];
			excludedOutOfRoot: string[];
	  }
	| {
			ok: false;
			/** Structured cause when the reader could tell (absent for legacy `null` stubs). */
			failure?: {
				code: string | null;
				status: number | null;
				stderrTail: string;
			};
	  }
> {
	const read = await runGitStatusRead(GIT_STATUS_ARGS, directory);
	if (read === null) return { ok: false };
	if ('cause' in read) return { ok: false, failure: read.cause };
	const { dirtyPaths, excludedOutOfRoot } =
		parseTrackedDirtyPathsWithExclusions(read.stdout);
	return { ok: true, dirtyPaths, excludedOutOfRoot };
}

/**
 * Issue #2953 TOCTOU re-check: re-measure the tracked-dirty set immediately
 * before a destructive reset and compare it to the set the operator actually
 * confirmed (or the empty clean-tree set). Fail-closed in both directions
 * that matter: ANY newly-dirty tracked path refuses, and an unreadable
 * status refuses (a measurement that cannot be taken must never read as
 * "unchanged"). A file that got cleaner passes — strictly less destruction
 * than confirmed.
 */
export async function recheckBeforeDestructive(
	directory: string,
	expectedDirtyPaths: readonly string[],
): Promise<
	| { ok: true; dirtyPaths: string[] }
	| { ok: false; reason: string; newDirtyPaths: string[] }
> {
	const read = await readTrackedDirtyPaths(directory);
	if (!read.ok) {
		return {
			ok: false,
			// Keep the generic text byte-identical (#2953 contract); append
			// the cause ONLY when the async reader produced one (#3317
			// PRR-001) — legacy `null` stubs carry no detail and stay generic.
			reason: `git status could not be re-read before the destructive reset — the confirmed scope cannot be re-verified${
				read.failure ? `. Cause: ${describeUnreadableCause(read.failure)}` : ''
			}`,
			newDirtyPaths: [],
		};
	}
	const expected = new Set(expectedDirtyPaths);
	const newDirtyPaths = read.dirtyPaths.filter((p) => !expected.has(p));
	if (newDirtyPaths.length > 0) {
		return {
			ok: false,
			reason: `${newDirtyPaths.length} tracked file(s) changed after the close gate was verified`,
			newDirtyPaths,
		};
	}
	return { ok: true, dirtyPaths: read.dirtyPaths };
}

function pendingPath(directory: string): string {
	return validateSwarmPath(directory, PENDING_PURGE_PATH);
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
		// TTL expiry is silent: an expired record reads as absent. A
		// future-dated createdAt (beyond a 1-minute clock-skew allowance)
		// is corrupt/hostile and also reads as absent.
		if (!Number.isFinite(parsed.createdAt)) return null;
		if (parsed.createdAt > _internals.now() + 60_000) return null;
		if (_internals.now() - parsed.createdAt > PENDING_PURGE_TTL_MS) {
			return null;
		}
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
	const pending = readPending(projectRoot);
	if (!pending) {
		return {
			ok: false,
			reason:
				'no pending purge for this scope (expired, overwritten, or already executed)',
		};
	}
	const scope = resolveCandidates(scopeTarget, extra);
	const digest = scopeDigest(scope.kind, scope.candidates);
	if (pending.confirmToken !== token) {
		return { ok: false, reason: 'confirm token mismatch' };
	}
	if (pending.scopeDigest !== digest) {
		return {
			ok: false,
			reason:
				'purge scope changed since the token was issued — re-run the preview and confirm the new token',
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
