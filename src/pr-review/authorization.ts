/**
 * PR-review authorization boundary (issues #2383, #2385).
 *
 * Correlated one-use reviewer re-entry authorization, moved behind the
 * `src/pr-review/` boundary (issue #2385). This module replaces prompt-text
 * inspection (`MODE: PR_REVIEW`) as the ONLY way a direct Task dispatch of
 * `reviewer`/`test_engineer` may bypass the generic Stage-A task-workflow
 * requirement. The PR workflow controller issues an authorization bound to
 * the exact active session, workflow, run, base/head SHA, worktree revision
 * digest, role, and gate generation; the Task delegation gate consumes it
 * atomically, exactly once. Stale, cross-session, wrong-role, replayed,
 * expired, or revision-drifted requests fail closed to the normal gating
 * path.
 *
 * Binding verification: the CURRENT gate binding (head/revision/generation)
 * is supplied by the owning gate through a bound reader
 * (`bindPrReviewReentryBindingReader`) — the boundary must not import the
 * orchestration gate back. The gate binds its
 * `readPrReviewReentryBindingContext` at module init.
 *
 * Persistence: `.swarm/pr-review/reentry-authorizations/<session-stem>.json`,
 * guarded by a `proper-lockfile` lock (the same dependency the candidate
 * sidecar store uses). Bounded: at most MAX_ACTIVE_AUTHORIZATIONS unconsumed
 * authorizations per session; expired/unconsumed records are pruned on write.
 */

import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { PrReviewRunIdSchema } from '../background/pr-review-contract.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { prWorkflowSessionFileStem } from './persistence.js';

export type PrReviewReentryRole = 'reviewer' | 'test_engineer';

/** One-use authorization lifetime. Issued → immediately consumed by one Task call. */
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_AUTHORIZATIONS = 8;
const MAX_PERSISTED_AUTHORIZATIONS = 32;
const REENTRY_AUTHORIZATIONS_MAX_BYTES = 64 * 1024;

export interface PrReviewReentryAuthorizationRecord {
	schemaVersion: 1;
	authorizationId: string;
	sessionId: string;
	workflowInstanceId?: string;
	runId?: string;
	prHeadSha: string;
	revisionDigest: string;
	role: PrReviewReentryRole;
	generation: number;
	createdAt: string;
	expiresAt: string;
	consumedAt?: string;
	consumedCallId?: string;
}

/**
 * The CURRENT active-workflow binding an authorization must match at issue
 * AND at consume time. Supplied by the owning gate (which reads state through
 * the persistence boundary) via `bindPrReviewReentryBindingReader`.
 */
export interface PrReviewReentryBindingContext {
	prHeadSha: string;
	revisionDigest: string;
	generation: number;
	workflowInstanceId?: string;
	runId?: string;
}

export type PrReviewReentryBindingReader = (
	directory: string,
	sessionID: string,
) => Promise<PrReviewReentryBindingContext | null>;

let bindingReader: PrReviewReentryBindingReader | undefined;

export function bindPrReviewReentryBindingReader(
	reader: PrReviewReentryBindingReader,
): void {
	bindingReader = reader;
}

async function currentBinding(
	directory: string,
	sessionID: string,
): Promise<PrReviewReentryBindingContext | null> {
	if (!bindingReader) {
		throw new Error(
			'BLOCKED: re-entry authorization binding reader is not bound (the PR workflow gate must bind it at module init)',
		);
	}
	return bindingReader(directory, sessionID);
}

const PrReviewReentryAuthorizationRecordSchema = z
	.object({
		schemaVersion: z.literal(1),
		authorizationId: z.string().min(1).max(64),
		sessionId: z.string().min(1).max(256),
		workflowInstanceId: z.string().min(1).max(128).optional(),
		runId: PrReviewRunIdSchema.optional(),
		prHeadSha: z.string().regex(/^[0-9a-f]{6,64}$/i),
		revisionDigest: z.string().min(1).max(256),
		role: z.enum(['reviewer', 'test_engineer']),
		generation: z.number().int().nonnegative(),
		createdAt: z.string().datetime(),
		expiresAt: z.string().datetime(),
		consumedAt: z.string().datetime().optional(),
		consumedCallId: z.string().min(1).max(128).optional(),
	})
	.strict();

const AuthorizationFileSchema = z
	.object({
		schemaVersion: z.literal(1),
		sessionId: z.string().min(1).max(256),
		authorizations: z
			.array(PrReviewReentryAuthorizationRecordSchema)
			.max(MAX_PERSISTED_AUTHORIZATIONS),
	})
	.strict();

type AuthorizationFile = z.infer<typeof AuthorizationFileSchema>;

function reentryAuthorizationFilePath(
	directory: string,
	sessionID: string,
): string {
	const relative = path.join(
		'pr-review',
		'reentry-authorizations',
		`${prWorkflowSessionFileStem(sessionID)}.json`,
	);
	return validateSwarmPath(directory, relative);
}

async function readAuthorizationFile(
	filePath: string,
): Promise<AuthorizationFile | null> {
	let raw: string;
	try {
		const stat = await fsp.stat(filePath);
		if (!stat.isFile() || stat.size > REENTRY_AUTHORIZATIONS_MAX_BYTES) {
			throw new Error(
				'reentry authorization store is not a bounded regular file',
			);
		}
		raw = await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const decoded: unknown = JSON.parse(raw);
	const parsed = AuthorizationFileSchema.safeParse(decoded);
	if (!parsed.success) {
		throw new Error(
			`reentry authorization store is invalid: ${parsed.error.issues
				.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
				.join('; ')}`,
		);
	}
	return parsed.data;
}

/**
 * Windows rename-over-existing can fail transiently (EPERM/EBUSY/EACCES/
 * EEXIST) while AV/indexers hold the target; mirror the bounded retry
 * discipline of `renameWithRetry` (src/utils/atomic-write.ts) and the
 * persistence adapter's atomic JSON write instead of single-shot rename.
 */
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200];
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES', 'EEXIST']);

async function renameWithRetryAsync(
	tempPath: string,
	targetPath: string,
): Promise<void> {
	let lastError: unknown;
	for (
		let attempt = 0;
		attempt <= _internals.renameRetryDelaysMs.length;
		attempt++
	) {
		try {
			await _internals.renameImpl(tempPath, targetPath);
			return;
		} catch (err) {
			lastError = err;
			const code = (err as NodeJS.ErrnoException)?.code;
			if (!code || !RETRYABLE_RENAME_CODES.has(code)) throw err;
			if (attempt < _internals.renameRetryDelaysMs.length) {
				await new Promise((resolve) =>
					setTimeout(resolve, _internals.renameRetryDelaysMs[attempt]),
				);
			}
		}
	}
	throw lastError;
}

async function writeAuthorizationFile(
	filePath: string,
	file: AuthorizationFile,
): Promise<void> {
	const serialized = `${JSON.stringify(file, null, 2)}\n`;
	if (
		Buffer.byteLength(serialized, 'utf8') > REENTRY_AUTHORIZATIONS_MAX_BYTES
	) {
		throw new Error('reentry authorization store exceeds its write bound');
	}
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomUUID()}.tmp`,
	);
	try {
		await fsp.writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
		await renameWithRetryAsync(tempPath, filePath);
	} finally {
		await fsp.rm(tempPath, { force: true }).catch(() => undefined);
	}
}

/** Drop consumed/expired records past the retention bound; keep newest first. */
function pruneAuthorizations(
	records: readonly PrReviewReentryAuthorizationRecord[],
	nowMs: number,
): PrReviewReentryAuthorizationRecord[] {
	const kept: PrReviewReentryAuthorizationRecord[] = [];
	for (const record of [...records]
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
		.slice(0, MAX_PERSISTED_AUTHORIZATIONS)) {
		if (record.consumedAt) continue;
		if (Date.parse(record.expiresAt) <= nowMs) continue;
		kept.push(record);
	}
	return kept;
}

// proper-lockfile is a CommonJS module without published TypeScript types
// (same treatment as candidate-sidecar-store.ts).
interface LockfileModule {
	lock(
		path: string,
		options: {
			lockfilePath?: string;
			retries?: { retries: number; minTimeout: number; maxTimeout: number };
			stale?: number;
			update?: number;
			realpath?: boolean;
		},
	): Promise<() => Promise<unknown>>;
}
const lf = lockfile as unknown as LockfileModule;

async function withAuthorizationLock<T>(
	filePath: string,
	write: () => Promise<T>,
): Promise<T> {
	// The store directory must exist before proper-lockfile creates the lock
	// file inside it (the very first issuance otherwise hits ENOENT).
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	const release = await lf.lock(path.dirname(filePath), {
		lockfilePath: `${filePath}.lock`,
		retries: { retries: 8, minTimeout: 10, maxTimeout: 100 },
		stale: 10_000,
		update: 1_000,
		realpath: false,
	});
	try {
		return await write();
	} finally {
		await release().catch(() => undefined);
	}
}

/**
 * Issue a one-use authorization for the CURRENT active PR_REVIEW workflow.
 * Fails when no active head-bound PR_REVIEW gate exists for the session, or
 * when an unconsumed authorization for the same role and generation already
 * exists (no stockpiling: issue, then immediately Task-dispatch the role).
 */
export async function issuePrReviewReentryAuthorization(
	directory: string,
	sessionID: string,
	request: { runId?: string; prHeadSha: string; role: PrReviewReentryRole },
): Promise<PrReviewReentryAuthorizationRecord> {
	const trimmedSession = sessionID.trim();
	if (!trimmedSession) {
		throw new Error(
			'BLOCKED: re-entry authorization requires an active sessionID',
		);
	}
	const binding = await currentBinding(directory, trimmedSession);
	if (!binding || binding.prHeadSha !== request.prHeadSha.toLowerCase()) {
		throw new Error(
			`BLOCKED: re-entry authorization requires an active PR_REVIEW workflow bound to the declared head (active: ${binding?.prHeadSha ?? '(none)'})`,
		);
	}
	if (request.runId && binding.runId && request.runId !== binding.runId) {
		throw new Error(
			'BLOCKED: re-entry authorization run does not match the active PR-review run',
		);
	}
	const filePath = reentryAuthorizationFilePath(directory, trimmedSession);
	return withAuthorizationLock(filePath, async () => {
		const existing = await readAuthorizationFile(filePath);
		const nowMs = Date.now();
		const now = new Date(nowMs).toISOString();
		const records = pruneAuthorizations(existing?.authorizations ?? [], nowMs);
		const active = records.filter(
			(record) =>
				!record.consumedAt &&
				record.role === request.role &&
				record.generation === binding.generation,
		);
		if (active.length > 0) {
			throw new Error(
				`BLOCKED: an unconsumed re-entry authorization for role "${request.role}" at generation ${binding.generation} already exists; use it (one immediate Task dispatch) before issuing another`,
			);
		}
		if (records.length >= MAX_ACTIVE_AUTHORIZATIONS) {
			throw new Error(
				`BLOCKED: re-entry authorization store is at its bound of ${MAX_ACTIVE_AUTHORIZATIONS} active authorizations`,
			);
		}
		const record: PrReviewReentryAuthorizationRecord = {
			schemaVersion: 1,
			authorizationId: randomUUID(),
			sessionId: trimmedSession,
			...(binding.workflowInstanceId
				? { workflowInstanceId: binding.workflowInstanceId }
				: {}),
			...(binding.runId ? { runId: binding.runId } : {}),
			prHeadSha: binding.prHeadSha,
			revisionDigest: binding.revisionDigest,
			role: request.role,
			generation: binding.generation,
			createdAt: now,
			expiresAt: new Date(nowMs + AUTHORIZATION_TTL_MS).toISOString(),
		};
		await writeAuthorizationFile(filePath, {
			schemaVersion: 1,
			sessionId: trimmedSession,
			authorizations: [record, ...records],
		});
		return record;
	});
}

/**
 * Atomically consume the one active authorization for this session+role.
 * Re-verifies the binding against the CURRENT PR_REVIEW gate state — any
 * drift (mode change, head change, revision digest change, generation bump)
 * fails closed to null, as does replay, expiry, cross-session use, or wrong
 * role. Returns the consumed record on success.
 */
export async function consumePrReviewReentryAuthorization(
	directory: string,
	sessionID: string,
	request: { role: PrReviewReentryRole; callID: string },
): Promise<PrReviewReentryAuthorizationRecord | null> {
	const trimmedSession = sessionID.trim();
	if (!trimmedSession) return null;
	const filePath = reentryAuthorizationFilePath(directory, trimmedSession);
	try {
		return await withAuthorizationLock(filePath, async () => {
			const existing = await readAuthorizationFile(filePath);
			if (!existing) return null;
			const nowMs = Date.now();
			const records = pruneAuthorizations(existing.authorizations, nowMs);
			const index = records.findIndex(
				(record) =>
					!record.consumedAt &&
					record.role === request.role &&
					record.sessionId === trimmedSession &&
					Date.parse(record.expiresAt) > nowMs,
			);
			if (index < 0) {
				// Persist the prune even when nothing is consumable, so expired
				// records do not accumulate.
				if (records.length !== existing.authorizations.length) {
					await writeAuthorizationFile(filePath, {
						...existing,
						authorizations: records,
					});
				}
				return null;
			}
			// Re-verify against the CURRENT gate state BEFORE consuming: the
			// authorization is generation- and revision-bound, so any workflow
			// progress since issuance invalidates it.
			const binding = await currentBinding(directory, trimmedSession);
			const candidate = records[index]!;
			if (
				!binding ||
				binding.prHeadSha !== candidate.prHeadSha ||
				binding.revisionDigest !== candidate.revisionDigest ||
				binding.generation !== candidate.generation ||
				(candidate.workflowInstanceId !== undefined &&
					binding.workflowInstanceId !== candidate.workflowInstanceId) ||
				(candidate.workflowInstanceId === undefined &&
					binding.workflowInstanceId !== undefined)
			) {
				return null;
			}
			const consumed: PrReviewReentryAuthorizationRecord = {
				...candidate,
				consumedAt: new Date(nowMs).toISOString(),
				consumedCallId: request.callID,
			};
			records[index] = consumed;
			await writeAuthorizationFile(filePath, {
				...existing,
				authorizations: records,
			});
			return consumed;
		});
	} catch {
		// Fail closed to the normal gating path on any store error: a broken
		// authorization store must never weaken the Stage-A requirement by
		// accident, and must never block an ordinary Task dispatch either.
		return null;
	}
}

export const _internals = {
	AUTHORIZATION_TTL_MS,
	MAX_ACTIVE_AUTHORIZATIONS,
	reentryAuthorizationFilePath,
	pruneAuthorizations,
	/** DI seam: the rename implementation (tests inject failure modes). */
	renameImpl: (from: string, to: string): Promise<void> => fsp.rename(from, to),
	/** DI seam: retry backoff schedule (tests shrink to avoid real sleeps). */
	renameRetryDelaysMs: RENAME_RETRY_DELAYS_MS,
	renameWithRetryAsync,
	writeAuthorizationFile,
};
