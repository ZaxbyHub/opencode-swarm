/**
 * PR-review authorization boundary (issues #2383, #2385).
 *
 * Correlated one-use reviewer re-entry authorization, moved behind the
 * `src/pr-review/` boundary (issue #2385). This module replaces prompt-text
 * inspection (`MODE: PR_REVIEW`) as the ONLY way a direct Task dispatch of
 * `reviewer`/`test_engineer` may bypass the generic Stage-A task-workflow
 * requirement. The PR workflow controller issues an authorization bound to
 * the exact active session, workflow, run, base/head SHA, worktree revision
 * digest, role, and gate generation; the PR workflow controller boundary
 * reserves it atomically for exactly one Task call and the Task delegation
 * gate verifies that same call-bound reservation (idempotent for the same
 * callID). Stale, cross-session, wrong-role, replayed, expired, or
 * revision-drifted requests fail closed to the normal gating path.
 *
 * Binding verification: the CURRENT gate binding (head/revision/generation)
 * is supplied by the owning gate through a bound reader
 * (`bindPrReviewReentryBindingReader`) — the boundary must not import the
 * orchestration gate back. The gate binds its
 * `readPrReviewReentryBindingContext` at module init.
 *
 * Persistence: SQLite coordination state is authoritative; the legacy
 * `.swarm/pr-review/reentry-authorizations/<session-stem>.json` path remains a
 * post-commit shadow projection and one-time import source only.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import { PrReviewRunIdSchema } from '../background/pr-review-contract.js';
import {
	getCoordinationState,
	importCoordinationOnce,
	transitionCoordinationState,
} from '../db/coordination-store.js';
import { validateSwarmPath } from '../hooks/utils.js';
import {
	prWorkflowSessionFileStem,
	withSessionStateMutation,
} from './persistence.js';

export type PrReviewReentryRole = 'reviewer' | 'test_engineer';

/** One-use authorization lifetime. Issued → immediately consumed by one Task call. */
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_AUTHORIZATIONS = 8;
const MAX_PERSISTED_AUTHORIZATIONS = 32;
const REENTRY_AUTHORIZATIONS_MAX_BYTES = 64 * 1024;
const AUTHORIZATION_COORDINATION_PREFIX = 'pr-review.reentry-authorizations';
const AUTHORIZATION_ENTITY_KEY = 'authorizations';
const MAX_AUTHORIZATION_WRITE_ATTEMPTS = 5;

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

interface AuthorizationStoreRow {
	rowRevision: number;
	rowGeneration: number;
	store: AuthorizationFile;
}

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

function reentryAuthorizationImportedPath(
	directory: string,
	sessionID: string,
): string {
	return `${reentryAuthorizationFilePath(directory, sessionID)}.imported`;
}

function reentryAuthorizationProjectionMarkerPath(
	directory: string,
	sessionID: string,
): string {
	return `${reentryAuthorizationFilePath(directory, sessionID)}.sqlite-projection`;
}

function reentryAuthorizationCoordinationNamespace(sessionID: string): string {
	return `${AUTHORIZATION_COORDINATION_PREFIX}:${prWorkflowSessionFileStem(sessionID)}`;
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

function parseAuthorizationPayload(
	payload: string,
	sessionID: string,
): AuthorizationFile {
	const decoded: unknown = JSON.parse(payload);
	const parsed = AuthorizationFileSchema.safeParse(decoded);
	if (!parsed.success || parsed.data.sessionId !== sessionID) {
		throw new Error(
			`reentry authorization store is invalid for session "${sessionID}"`,
		);
	}
	return parsed.data;
}

function readAuthorizationsFromCoordination(
	directory: string,
	sessionID: string,
): AuthorizationStoreRow | null {
	const row = getCoordinationState(
		directory,
		reentryAuthorizationCoordinationNamespace(sessionID),
		AUTHORIZATION_ENTITY_KEY,
	);
	if (!row) return null;
	return {
		rowRevision: row.revision,
		rowGeneration: row.generation,
		store: parseAuthorizationPayload(row.payload, sessionID),
	};
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
	const serialized = serializeAuthorizationFile(file);
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

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fsp.stat(filePath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function serializeAuthorizationFile(file: AuthorizationFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function writeProjectionMarker(filePath: string): Promise<void> {
	await fsp.mkdir(path.dirname(filePath), { recursive: true });
	await fsp.writeFile(filePath, 'sqlite-projection\n', 'utf8');
}

async function collisionSafeImportedPath(filePath: string): Promise<string> {
	const canonical = `${filePath}.imported`;
	if (!(await fileExists(canonical))) return canonical;
	for (let suffix = 1; suffix <= 10_000; suffix += 1) {
		const candidate = `${canonical}.${suffix}`;
		if (!(await fileExists(candidate))) return candidate;
	}
	throw new Error(
		`No collision-safe archive path available for ${path.basename(filePath)}`,
	);
}

async function archiveShadowSource(filePath: string): Promise<void> {
	if (!(await fileExists(filePath))) return;
	await renameWithRetryAsync(
		filePath,
		await collisionSafeImportedPath(filePath),
	);
}

async function syncAuthorizationShadowProjection(
	directory: string,
	sessionID: string,
	store: AuthorizationFile,
	options: { archiveLegacy: boolean },
): Promise<void> {
	const filePath = reentryAuthorizationFilePath(directory, sessionID);
	if (options.archiveLegacy && (await fileExists(filePath))) {
		await archiveShadowSource(filePath);
	}
	await writeAuthorizationFile(filePath, store);
	await writeProjectionMarker(
		reentryAuthorizationProjectionMarkerPath(directory, sessionID),
	);
}

async function repairImportedAuthorizationShadow(
	directory: string,
	sessionID: string,
	store: AuthorizationFile,
): Promise<void> {
	const filePath = reentryAuthorizationFilePath(directory, sessionID);
	const markerPath = reentryAuthorizationProjectionMarkerPath(
		directory,
		sessionID,
	);
	const live = await readTextFileIfExists(filePath);
	if (live === null) {
		await syncAuthorizationShadowProjection(directory, sessionID, store, {
			archiveLegacy: false,
		});
		return;
	}
	const canonicalImportedExists = await fileExists(
		reentryAuthorizationImportedPath(directory, sessionID),
	);
	const markerExists = await fileExists(markerPath);
	const projected = serializeAuthorizationFile(store);
	if (canonicalImportedExists && markerExists && live === projected) return;
	if (canonicalImportedExists && live === projected) {
		await writeProjectionMarker(markerPath);
		return;
	}
	await syncAuthorizationShadowProjection(directory, sessionID, store, {
		archiveLegacy: true,
	});
}

async function readAuthorizationsAuthoritative(
	directory: string,
	sessionID: string,
): Promise<AuthorizationStoreRow | null> {
	const existing = readAuthorizationsFromCoordination(directory, sessionID);
	if (existing) {
		await repairImportedAuthorizationShadow(
			directory,
			sessionID,
			existing.store,
		);
		return existing;
	}
	const filePath = reentryAuthorizationFilePath(directory, sessionID);
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const legacy = await readAuthorizationFile(filePath);
	if (!legacy) return null;
	const outcome = importCoordinationOnce(
		directory,
		{
			source: path.join(
				'pr-review',
				'reentry-authorizations',
				`${prWorkflowSessionFileStem(sessionID)}.json`,
			),
			sourceDigest: createHash('sha256').update(raw).digest('hex'),
			rowCount: legacy.authorizations.length,
			emptyNamespace: reentryAuthorizationCoordinationNamespace(sessionID),
		},
		() => {
			const result = transitionCoordinationState(directory, {
				namespace: reentryAuthorizationCoordinationNamespace(sessionID),
				entityKey: AUTHORIZATION_ENTITY_KEY,
				expectedRevision: null,
				generation: 1,
				status: 'authorizations',
				payload: JSON.stringify(legacy),
			});
			if (result.outcome !== 'applied') {
				throw new Error(
					`reentry authorization import failed: ${result.outcome}`,
				);
			}
		},
	);
	const imported = readAuthorizationsFromCoordination(directory, sessionID);
	if (imported && outcome === 'imported') {
		await syncAuthorizationShadowProjection(
			directory,
			sessionID,
			imported.store,
			{ archiveLegacy: true },
		);
	}
	return imported;
}

function persistAuthorizationsAuthoritative(
	directory: string,
	sessionID: string,
	store: AuthorizationFile,
	expectedRevision: number | null,
	generation: number,
): { outcome: 'applied' | 'revision_conflict' | 'stale_generation' } {
	const result = transitionCoordinationState(directory, {
		namespace: reentryAuthorizationCoordinationNamespace(sessionID),
		entityKey: AUTHORIZATION_ENTITY_KEY,
		expectedRevision,
		generation,
		status: 'authorizations',
		payload: JSON.stringify(store),
	});
	if (
		result.outcome !== 'applied' &&
		result.outcome !== 'revision_conflict' &&
		result.outcome !== 'stale_generation'
	) {
		throw new Error(
			`reentry authorization persistence failed: ${result.outcome}`,
		);
	}
	return { outcome: result.outcome };
}

/**
 * Drop expired records past the retention bound while preserving every live
 * authorization. Consumed records are retained only as same-call replay
 * evidence, so they fill the remaining bounded capacity after live records.
 */
function pruneAuthorizations(
	records: readonly PrReviewReentryAuthorizationRecord[],
	nowMs: number,
): PrReviewReentryAuthorizationRecord[] {
	const unexpired = records.filter(
		(record) => Date.parse(record.expiresAt) > nowMs,
	);
	const newest = (
		left: PrReviewReentryAuthorizationRecord,
		right: PrReviewReentryAuthorizationRecord,
	) => {
		const leftAt = left.consumedAt ?? left.createdAt;
		const rightAt = right.consumedAt ?? right.createdAt;
		return leftAt === rightAt ? 0 : leftAt > rightAt ? -1 : 1;
	};
	const live = unexpired.filter((record) => !record.consumedAt).sort(newest);
	const consumed = unexpired
		.filter((record) => Boolean(record.consumedAt))
		.sort(newest);
	return [
		...live,
		...consumed.slice(
			0,
			Math.max(0, MAX_PERSISTED_AUTHORIZATIONS - live.length),
		),
	];
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
	return withSessionStateMutation(directory, trimmedSession, async () => {
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
		for (
			let attempt = 0;
			attempt < MAX_AUTHORIZATION_WRITE_ATTEMPTS;
			attempt++
		) {
			const existing = await readAuthorizationsAuthoritative(
				directory,
				trimmedSession,
			);
			const nowMs = Date.now();
			const now = new Date(nowMs).toISOString();
			const records = pruneAuthorizations(
				existing?.store.authorizations ?? [],
				nowMs,
			);
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
			if (
				records.filter((record) => !record.consumedAt).length >=
				MAX_ACTIVE_AUTHORIZATIONS
			) {
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
			const nextStore: AuthorizationFile = {
				schemaVersion: 1,
				sessionId: trimmedSession,
				authorizations: [record, ...records].slice(
					0,
					MAX_PERSISTED_AUTHORIZATIONS,
				),
			};
			const persisted = persistAuthorizationsAuthoritative(
				directory,
				trimmedSession,
				nextStore,
				existing?.rowRevision ?? null,
				(existing?.rowGeneration ?? 0) + 1,
			);
			if (persisted.outcome !== 'applied') continue;
			await syncAuthorizationShadowProjection(
				directory,
				trimmedSession,
				nextStore,
				{ archiveLegacy: false },
			);
			return record;
		}
		throw new Error(
			'BLOCKED: re-entry authorization store changed concurrently; reload the active session state before retrying',
		);
	});
}

function authorizationMatchesBinding(
	record: PrReviewReentryAuthorizationRecord,
	binding: PrReviewReentryBindingContext,
): boolean {
	return (
		binding.prHeadSha === record.prHeadSha &&
		binding.revisionDigest === record.revisionDigest &&
		binding.generation === record.generation &&
		binding.workflowInstanceId === record.workflowInstanceId &&
		binding.runId === record.runId
	);
}

/**
 * Read-only admission check for the PR workflow hook. The workflow-session
 * lock is held by the caller while this authorization-store lock is acquired,
 * so the binding used for the check cannot change underneath the read. The
 * token remains unconsumed until the delegation gate has accepted the Task.
 */
export async function hasPrReviewReentryAuthorizationAgainstBinding(
	directory: string,
	sessionID: string,
	request: { role: PrReviewReentryRole },
	binding: PrReviewReentryBindingContext,
): Promise<boolean> {
	const trimmedSession = sessionID.trim();
	if (!trimmedSession) return false;
	try {
		const existing = await readAuthorizationsAuthoritative(
			directory,
			trimmedSession,
		);
		if (!existing) return false;
		const records = pruneAuthorizations(
			existing.store.authorizations,
			Date.now(),
		);
		return records.some(
			(record) =>
				!record.consumedAt &&
				record.role === request.role &&
				record.sessionId === trimmedSession &&
				authorizationMatchesBinding(record, binding),
		);
	} catch {
		return false;
	}
}

/**
 * Reserve or verify one authorization against a binding whose owning workflow
 * lock is held by the caller. The authorization-file lock is always acquired
 * second. A consumed record is retained until expiry so the exact same Task
 * call can verify its reservation in a later hook (and after process restart).
 */
export async function reservePrReviewReentryAuthorizationAgainstBinding(
	directory: string,
	sessionID: string,
	request: { role: PrReviewReentryRole; callID: string },
	binding: PrReviewReentryBindingContext,
): Promise<PrReviewReentryAuthorizationRecord | null> {
	const trimmedSession = sessionID.trim();
	if (!trimmedSession) return null;
	try {
		for (
			let attempt = 0;
			attempt < MAX_AUTHORIZATION_WRITE_ATTEMPTS;
			attempt++
		) {
			const existing = await readAuthorizationsAuthoritative(
				directory,
				trimmedSession,
			);
			if (!existing) return null;
			const nowMs = Date.now();
			const records = pruneAuthorizations(existing.store.authorizations, nowMs);
			const sameCallIndex = records.findIndex(
				(record) =>
					record.consumedCallId === request.callID &&
					record.role === request.role &&
					record.sessionId === trimmedSession &&
					Date.parse(record.expiresAt) > nowMs,
			);
			const index =
				sameCallIndex >= 0
					? sameCallIndex
					: records.findIndex(
							(record) =>
								!record.consumedAt &&
								record.role === request.role &&
								record.sessionId === trimmedSession &&
								Date.parse(record.expiresAt) > nowMs,
						);
			if (index < 0) {
				if (records.length !== existing.store.authorizations.length) {
					const prunedStore: AuthorizationFile = {
						...existing.store,
						authorizations: records,
					};
					const persisted = persistAuthorizationsAuthoritative(
						directory,
						trimmedSession,
						prunedStore,
						existing.rowRevision,
						existing.rowGeneration + 1,
					);
					if (persisted.outcome !== 'applied') continue;
					await syncAuthorizationShadowProjection(
						directory,
						trimmedSession,
						prunedStore,
						{ archiveLegacy: false },
					);
				}
				return null;
			}
			const candidate = records[index]!;
			if (!authorizationMatchesBinding(candidate, binding)) {
				return null;
			}
			if (candidate.consumedCallId === request.callID) return candidate;
			const consumed: PrReviewReentryAuthorizationRecord = {
				...candidate,
				consumedAt: new Date(nowMs).toISOString(),
				consumedCallId: request.callID,
			};
			records[index] = consumed;
			const nextStore: AuthorizationFile = {
				...existing.store,
				authorizations: records,
			};
			const persisted = persistAuthorizationsAuthoritative(
				directory,
				trimmedSession,
				nextStore,
				existing.rowRevision,
				existing.rowGeneration + 1,
			);
			if (persisted.outcome !== 'applied') continue;
			await syncAuthorizationShadowProjection(
				directory,
				trimmedSession,
				nextStore,
				{ archiveLegacy: false },
			);
			return consumed;
		}
		return null;
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
	reentryAuthorizationCoordinationNamespace,
	pruneAuthorizations,
	authorizationMatchesBinding,
	hasPrReviewReentryAuthorizationAgainstBinding,
	/** DI seam: the rename implementation (tests inject failure modes). */
	renameImpl: (from: string, to: string): Promise<void> => fsp.rename(from, to),
	/** DI seam: retry backoff schedule (tests shrink to avoid real sleeps). */
	renameRetryDelaysMs: RENAME_RETRY_DELAYS_MS,
	renameWithRetryAsync,
	writeAuthorizationFile,
};
