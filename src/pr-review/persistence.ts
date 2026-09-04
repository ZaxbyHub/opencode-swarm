/**
 * PR-review workflow persistence adapter (issues #2385).
 *
 * The single atomic persistence boundary for PR-review workflow state, moved
 * from `src/hooks/pr-workflow-gate.ts` (region: state locks, CAS write,
 * bounded parsing, atomic JSON writes, safe-parent/identity assertions, path
 * helpers, in-memory caches). Every durable PR-review gate-state write goes
 * through this module; the recurrence sweep (issue #2385) forbids direct
 * writes to the state shape outside this boundary.
 *
 * Binding contract (issue #2385 plan, critic item 1): the owning gate binds
 * (a) its full Zod state codec via `bindPrReviewStateCodec` and (b) its
 * `_test_exports` object via `bindPrReviewPersistenceHooks`. Properties are
 * read at CALL time through the bound reference — never destructured at bind
 * time — so test-time property mutation and `resetTrackedStateCache` remain
 * fully visible. Defaults in `defaultPersistenceHooks` make the module usable
 * standalone and are what the gate resets seams back to.
 *
 * The recovery-salvage reader (`readPrWorkflowGateStateForRecovery`) remains
 * in the gate: it composes PR_FEEDBACK sub-schemas (gate-owned) and is a
 * read-only diagnostic built on these primitives.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ZodError } from 'zod';
import {
	deleteCoordinationState,
	getCoordinationState,
	importCoordinationOnce,
	transitionCoordinationState,
} from '../db/coordination-store.js';
import type { PrWorkflowGateState } from '../hooks/pr-workflow-gate.js';
import { validateSwarmPath } from '../hooks/utils.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';

// ---------------------------------------------------------------------------
// Session identity / path helpers
// ---------------------------------------------------------------------------

export function normalizeSessionID(sessionID: string): string {
	const normalized = sessionID.trim();
	if (!normalized) {
		throw new Error('BLOCKED: PR workflow gate requires a non-empty sessionID');
	}
	return normalized;
}

export function prWorkflowSessionFileStem(sessionID: string): string {
	const normalized = normalizeSessionID(sessionID);
	const slug =
		normalized.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'session';
	const digest = createHash('sha256')
		.update(normalized)
		.digest('hex')
		.slice(0, 12);
	return `${slug}-${digest}`;
}

export const WORKFLOW_GATE_DIR = 'pr-workflow-gates';
const WORKFLOW_STATE_COORDINATION_PREFIX = 'pr-workflow.state';
const WORKFLOW_STATE_ENTITY_KEY = 'state';

export function workflowGateStateRelativePath(sessionID: string): string {
	return path.join(
		WORKFLOW_GATE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.json`,
	);
}

export function workflowGateStateLockRelativePath(sessionID: string): string {
	return path.join(
		WORKFLOW_GATE_DIR,
		`${prWorkflowSessionFileStem(sessionID)}.lock`,
	);
}

export function workflowCheckoutMutationLockRelativePath(): string {
	return path.join(WORKFLOW_GATE_DIR, 'checkout.lock');
}

export function workflowGateStatePath(
	directory: string,
	sessionID: string,
): string {
	return validateSwarmPath(directory, workflowGateStateRelativePath(sessionID));
}

function workflowGateStateImportedPath(
	directory: string,
	sessionID: string,
): string {
	return `${workflowGateStatePath(directory, sessionID)}.imported`;
}

function workflowGateStateProjectionMarkerPath(
	directory: string,
	sessionID: string,
): string {
	return `${workflowGateStatePath(directory, sessionID)}.sqlite-projection`;
}

function workflowGateStateCoordinationNamespace(sessionID: string): string {
	return `${WORKFLOW_STATE_COORDINATION_PREFIX}:${prWorkflowSessionFileStem(sessionID)}`;
}

function workflowGateStateLockPath(
	directory: string,
	sessionID: string,
): string {
	return validateSwarmPath(
		directory,
		workflowGateStateLockRelativePath(sessionID),
	);
}

function workflowCheckoutMutationLockPath(directory: string): string {
	return validateSwarmPath(
		directory,
		workflowCheckoutMutationLockRelativePath(),
	);
}

// ---------------------------------------------------------------------------
// Bounded caches + misc helpers
// ---------------------------------------------------------------------------

export const MAX_TRACKED_SESSIONS = 200;
const MAX_COMPLETED_CHECKOUT_LOCK_OWNERS = 64;

const WINDOWS_RENAME_MAX_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_MAX_ATTEMPTS = 50;
const STATE_MUTATION_LOCK_RETRY_DELAY_MS = 10;
const STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS = 30_000;
export const CHECKOUT_MUTATION_ACTION_TIMEOUT_MS = 5 * 60_000;

export const trackedStatesByProjectSession = new Map<
	string,
	PrWorkflowPersistedStateBase
>();
const pendingStateMutationsByProjectSession = new Map<string, Promise<void>>();
const pendingCheckoutMutationsByProject = new Map<string, Promise<void>>();
const completedCheckoutLockOwners = new Map<string, string>();

interface SessionStateMutationLock {
	ownerToken: string;
	pid: number;
	createdAtMs: number;
}

export function isoNow(): string {
	return new Date().toISOString();
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sameBigIntFileIdentity(
	left: Pick<BigIntStats, 'dev' | 'ino'>,
	right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

export function normalizeComparableFsPath(value: string): string {
	const normalized = path.normalize(path.resolve(value));
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function stateCacheKey(directory: string, sessionID: string): string {
	return `${canonicalRootKeyFresh(directory)}\u0000${normalizeSessionID(sessionID)}`;
}

export function rememberState<S extends PrWorkflowPersistedStateBase>(
	directory: string,
	state: S,
): void {
	const cacheKey = stateCacheKey(directory, state.sessionID);
	trackedStatesByProjectSession.delete(cacheKey);
	trackedStatesByProjectSession.set(cacheKey, state);
	while (trackedStatesByProjectSession.size > MAX_TRACKED_SESSIONS) {
		const oldestKey = trackedStatesByProjectSession.keys().next().value;
		if (!oldestKey) break;
		trackedStatesByProjectSession.delete(oldestKey);
	}
}

/** Drop one session's cached state (gate clear/abort paths). */
export function forgetTrackedPrWorkflowState(
	directory: string,
	sessionID: string,
): void {
	trackedStatesByProjectSession.delete(stateCacheKey(directory, sessionID));
}

/** Test reset: clear every in-process persistence cache/queue. */
export function resetPrReviewPersistenceCaches(): void {
	trackedStatesByProjectSession.clear();
	pendingStateMutationsByProjectSession.clear();
	pendingCheckoutMutationsByProject.clear();
	completedCheckoutLockOwners.clear();
}

// ---------------------------------------------------------------------------
// Bindable hooks (call-time reads; the gate binds its `_test_exports`)
// ---------------------------------------------------------------------------

export interface PrReviewPersistenceHooks {
	nowMs: () => number;
	isProcessAlive: (pid: number) => boolean;
	openCheckoutLock: (lockPath: string) => ReturnType<typeof fsp.open>;
	removeCheckoutLock: (lockPath: string) => Promise<void>;
	checkoutMutationActionTimeoutMs: number;
	rename: (from: string, to: string) => Promise<void>;
	beforeSessionStateLockWrite?: () => Promise<void>;
	beforeCheckoutLockWrite?: () => Promise<void>;
	beforeSafeDirectoryCreate?: (
		parentPath: string,
		nextPath: string,
	) => Promise<void>;
	beforeAtomicTempWrite?: () => Promise<void>;
	beforeAtomicRename?: () => Promise<void>;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// Permission errors prove the process exists. Unknown errors fail closed.
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
}

export const defaultPersistenceHooks: PrReviewPersistenceHooks = {
	nowMs: () => Date.now(),
	isProcessAlive: defaultIsProcessAlive,
	openCheckoutLock: (lockPath) => fsp.open(lockPath, 'wx'),
	removeCheckoutLock: (lockPath) => fsp.rm(lockPath),
	checkoutMutationActionTimeoutMs: CHECKOUT_MUTATION_ACTION_TIMEOUT_MS,
	rename: (from, to) => fsp.rename(from, to),
};

let hooks: PrReviewPersistenceHooks = defaultPersistenceHooks;

/**
 * Bind the persistence seam. The gate passes its `_test_exports` object (same
 * reference) so property mutation by tests is read at call time.
 */
export function bindPrReviewPersistenceHooks(
	nextHooks: PrReviewPersistenceHooks,
): void {
	hooks = nextHooks;
}

// ---------------------------------------------------------------------------
// Bindable state codec (bounded schema parsing)
// ---------------------------------------------------------------------------

/** Structural minimum the CAS machinery relies on. */
export interface PrWorkflowPersistedStateBase {
	schemaVersion: number;
	revision: number;
	sessionID: string;
	workflowInstanceId?: string;
}

export interface PrReviewStateCodec<S extends PrWorkflowPersistedStateBase> {
	safeParse: (
		data: unknown,
	) => { success: true; data: S } | { success: false; error: ZodError };
	parse: (data: unknown) => S;
}

let codec: PrReviewStateCodec<PrWorkflowPersistedStateBase> | undefined;

export function bindPrReviewStateCodec<S extends PrWorkflowPersistedStateBase>(
	nextCodec: PrReviewStateCodec<S>,
): void {
	codec = nextCodec as PrReviewStateCodec<PrWorkflowPersistedStateBase>;
}

function requireCodec(): PrReviewStateCodec<PrWorkflowPersistedStateBase> {
	if (!codec) {
		throw new Error(
			'BLOCKED: PR workflow persistence codec is not bound (the gate must bind it at module init)',
		);
	}
	return codec;
}

// ---------------------------------------------------------------------------
// Safe-parent + file-identity assertions (containment defense)
// ---------------------------------------------------------------------------

export async function ensurePrWorkflowSafeParentDirectory(
	directory: string,
	filePath: string,
): Promise<string> {
	const swarmRoot = path.resolve(directory, '.swarm');
	const parentPath = path.dirname(path.resolve(filePath));
	const relativeParent = path.relative(swarmRoot, parentPath);
	if (
		relativeParent === '..' ||
		relativeParent.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeParent)
	) {
		throw new Error(
			'BLOCKED: PR workflow atomic destination escapes the project .swarm directory',
		);
	}
	await fsp.mkdir(swarmRoot, { recursive: true });
	let currentPath = swarmRoot;
	let currentIdentity = await assertSafeDirectory(currentPath, undefined);
	for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
		const nextPath = path.join(currentPath, segment);
		await hooks.beforeSafeDirectoryCreate?.(currentPath, nextPath);
		await assertSafeDirectory(currentPath, currentIdentity);
		try {
			await fsp.mkdir(nextPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
		await assertSafeDirectory(currentPath, currentIdentity);
		const nextIdentity = await assertSafeDirectory(nextPath, undefined);
		const [realCurrent, realNext] = await Promise.all([
			fsp.realpath(currentPath),
			fsp.realpath(nextPath),
		]);
		if (
			normalizeComparableFsPath(path.dirname(realNext)) !==
			normalizeComparableFsPath(realCurrent)
		) {
			throw new Error(
				'BLOCKED: PR workflow directory creation escaped the project .swarm tree',
			);
		}
		currentPath = nextPath;
		currentIdentity = nextIdentity;
	}
	const realRoot = await fsp.realpath(swarmRoot);
	const realParent = await fsp.realpath(parentPath);
	const relativeRealParent = path.relative(realRoot, realParent);
	if (
		relativeRealParent === '..' ||
		relativeRealParent.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeRealParent)
	) {
		throw new Error(
			'BLOCKED: PR workflow atomic parent escapes the project .swarm directory',
		);
	}
	return realParent;
}

async function assertSafeDirectory(
	directoryPath: string,
	expectedIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined,
): Promise<Pick<BigIntStats, 'dev' | 'ino'>> {
	const stat = await fsp.lstat(directoryPath, { bigint: true });
	if (
		stat.isSymbolicLink() ||
		!stat.isDirectory() ||
		(expectedIdentity && !sameBigIntFileIdentity(stat, expectedIdentity))
	) {
		throw new Error(
			'BLOCKED: PR workflow .swarm path must be a real directory and must not change during the operation',
		);
	}
	return { dev: stat.dev, ino: stat.ino };
}

async function assertOpenedSwarmFileIdentity(
	directory: string,
	filePath: string,
	handle: Awaited<ReturnType<typeof fsp.open>>,
	expectedParent: string,
	label: string,
): Promise<Pick<BigIntStats, 'dev' | 'ino'>> {
	const openedStat = await handle.stat({ bigint: true });
	if (!openedStat.isFile()) throw new Error(`BLOCKED: ${label} is not a file`);
	await assertClosedSwarmFileIdentity(
		directory,
		filePath,
		openedStat,
		expectedParent,
		label,
	);
	return { dev: openedStat.dev, ino: openedStat.ino };
}

async function assertClosedSwarmFileIdentity(
	directory: string,
	filePath: string,
	expectedIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined,
	expectedParent: string,
	label: string,
): Promise<void> {
	if (!expectedIdentity) throw new Error(`BLOCKED: ${label} has no identity`);
	const [stat, realRoot, realFile, realParent] = await Promise.all([
		fsp.lstat(filePath, { bigint: true }),
		fsp.realpath(path.resolve(directory, '.swarm')),
		fsp.realpath(filePath),
		fsp.realpath(path.dirname(filePath)),
	]);
	const relativeFile = path.relative(realRoot, realFile);
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		!sameBigIntFileIdentity(stat, expectedIdentity) ||
		normalizeComparableFsPath(realParent) !==
			normalizeComparableFsPath(expectedParent) ||
		relativeFile === '' ||
		relativeFile === '..' ||
		relativeFile.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relativeFile)
	) {
		throw new Error(`BLOCKED: ${label} changed or escaped .swarm`);
	}
}

// ---------------------------------------------------------------------------
// Atomic JSON write
// ---------------------------------------------------------------------------

export async function writeAtomicJson(
	directory: string,
	filePath: string,
	value: unknown,
): Promise<void> {
	const safeParent = await ensurePrWorkflowSafeParentDirectory(
		directory,
		filePath,
	);
	const tempPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;
	let tempIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined;
	let lastError: unknown;
	try {
		const handle = await fsp.open(tempPath, 'wx');
		try {
			await hooks.beforeAtomicTempWrite?.();
			tempIdentity = await assertOpenedSwarmFileIdentity(
				directory,
				tempPath,
				handle,
				safeParent,
				'PR workflow atomic temporary file',
			);
			await handle.writeFile(JSON.stringify(value, null, 2), 'utf-8');
			await handle.sync();
		} finally {
			await handle.close();
		}
		await hooks.beforeAtomicRename?.();
		await assertClosedSwarmFileIdentity(
			directory,
			tempPath,
			tempIdentity,
			safeParent,
			'PR workflow atomic temporary file',
		);
		for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
			try {
				await hooks.rename(tempPath, filePath);
				lastError = undefined;
				break;
			} catch (error) {
				lastError = error;
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
					break;
				}
				if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
					await delay(RENAME_RETRY_DELAY_MS);
				}
			}
		}
		if (lastError) {
			throw lastError;
		}
		await assertClosedSwarmFileIdentity(
			directory,
			filePath,
			tempIdentity,
			safeParent,
			'PR workflow atomic destination file',
		);
	} finally {
		try {
			await fsp.rm(tempPath, { force: true });
		} catch {
			// best-effort temp cleanup
		}
	}
}

/**
 * Write a PR-workflow artifact with the gate's Windows-safe atomic persistence
 * contract. Checkout-preparation receipts must survive the same transient
 * rename contention as canonical gate state.
 */
export async function writePrWorkflowAtomicJson(
	directory: string,
	filePath: string,
	value: unknown,
): Promise<void> {
	await writeAtomicJson(directory, filePath, value);
}

// ---------------------------------------------------------------------------
// Bounded state parsing (disk read)
// ---------------------------------------------------------------------------

export async function readPrWorkflowGateStateFromDisk<
	S extends PrWorkflowPersistedStateBase,
>(
	directory: string,
	sessionID: string,
	options: { allowSalvagedImport?: boolean } = {},
): Promise<S | null> {
	const authoritative = await readPrWorkflowGateStateFromCoordination<S>(
		directory,
		sessionID,
	);
	if (authoritative) {
		const merged = await mergeWorkflowGateShadowExtras(
			directory,
			sessionID,
			authoritative,
		);
		await repairImportedWorkflowGateShadow(directory, sessionID, merged);
		return merged;
	}
	return importLegacyPrWorkflowGateStateIfNeeded<S>(
		directory,
		sessionID,
		options.allowSalvagedImport === true,
	);
}

export async function readPrWorkflowGateStateFileRawFromDisk<
	S extends PrWorkflowPersistedStateBase,
>(filePath: string, stateLabel: string): Promise<S | null> {
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(raw);
	} catch {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${stateLabel}" is not valid JSON`,
		);
	}
	const bound = requireCodec() as PrReviewStateCodec<S>;
	const parsed = bound.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${stateLabel}" is invalid`,
		);
	}
	return parsed.data;
}

export async function readPrWorkflowGateStateFileFromDisk<
	S extends PrWorkflowPersistedStateBase,
>(filePath: string, stateLabel: string): Promise<S | null> {
	return readPrWorkflowGateStateFileRawFromDisk<S>(filePath, stateLabel);
}

export async function readPrWorkflowGateStateFromCoordination<
	S extends PrWorkflowPersistedStateBase,
>(directory: string, sessionID: string): Promise<S | null> {
	const decoded = readPrWorkflowGateStateCoordinationRow<S>(
		directory,
		sessionID,
	);
	return decoded?.state ?? null;
}

function readPrWorkflowGateStateCoordinationRow<
	S extends PrWorkflowPersistedStateBase,
>(
	directory: string,
	sessionID: string,
): { rowRevision: number; state: S } | null {
	const row = getCoordinationState(
		directory,
		workflowGateStateCoordinationNamespace(sessionID),
		WORKFLOW_STATE_ENTITY_KEY,
	);
	if (!row) return null;
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(row.payload);
	} catch {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is not valid JSON`,
		);
	}
	const bound = requireCodec() as PrReviewStateCodec<S>;
	const parsed = bound.safeParse(parsedJson);
	if (!parsed.success || parsed.data.revision !== row.generation) {
		throw new Error(
			`BLOCKED: PR workflow gate state for session "${sessionID}" is invalid`,
		);
	}
	return { rowRevision: row.revision, state: parsed.data };
}

function workflowStateStatus(state: PrWorkflowPersistedStateBase): string {
	const mode = (state as { mode?: unknown }).mode;
	return typeof mode === 'string' && mode.trim().length > 0 ? mode : 'active';
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

function serializeWorkflowGateState(
	state: PrWorkflowPersistedStateBase,
): string {
	return JSON.stringify(state, null, 2);
}

async function readTextFileIfExists(filePath: string): Promise<string | null> {
	try {
		return await fsp.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
}

async function writeProjectionMarker(
	directory: string,
	filePath: string,
): Promise<void> {
	await ensurePrWorkflowSafeParentDirectory(directory, filePath);
	await fsp.writeFile(filePath, 'sqlite-projection\n', 'utf8');
}

async function renameWithRetry(from: string, to: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
		try {
			await hooks.rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EBUSY') {
				throw error;
			}
			if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
				await delay(RENAME_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError;
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
	await renameWithRetry(filePath, await collisionSafeImportedPath(filePath));
}

async function syncWorkflowGateShadowProjection(
	directory: string,
	sessionID: string,
	state: PrWorkflowPersistedStateBase,
	options: { archiveLegacy: boolean },
): Promise<void> {
	const filePath = workflowGateStatePath(directory, sessionID);
	if (options.archiveLegacy && (await fileExists(filePath))) {
		await archiveShadowSource(filePath);
	}
	await writeAtomicJson(directory, filePath, state);
	await writeProjectionMarker(
		directory,
		workflowGateStateProjectionMarkerPath(directory, sessionID),
	);
}

async function repairImportedWorkflowGateShadow(
	directory: string,
	sessionID: string,
	state: PrWorkflowPersistedStateBase,
): Promise<void> {
	const filePath = workflowGateStatePath(directory, sessionID);
	const markerPath = workflowGateStateProjectionMarkerPath(
		directory,
		sessionID,
	);
	const live = await readTextFileIfExists(filePath);
	if (live === null) {
		await syncWorkflowGateShadowProjection(directory, sessionID, state, {
			archiveLegacy: false,
		});
		return;
	}
	const canonicalImportedExists = await fileExists(
		workflowGateStateImportedPath(directory, sessionID),
	);
	const markerExists = await fileExists(markerPath);
	const projected = serializeWorkflowGateState(state);
	if (canonicalImportedExists && markerExists && live === projected) return;
	if (canonicalImportedExists && live === projected) {
		await writeProjectionMarker(directory, markerPath);
		return;
	}
	await syncWorkflowGateShadowProjection(directory, sessionID, state, {
		archiveLegacy: true,
	});
}

async function mergeWorkflowGateShadowExtras<
	S extends PrWorkflowPersistedStateBase,
>(directory: string, sessionID: string, state: S): Promise<S> {
	const filePath = workflowGateStatePath(directory, sessionID);
	const live = await readTextFileIfExists(filePath);
	if (live === null) return state;
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(live);
	} catch {
		return state;
	}
	if (
		!parsedJson ||
		typeof parsedJson !== 'object' ||
		Array.isArray(parsedJson)
	) {
		return state;
	}
	return {
		...(parsedJson as Record<string, unknown>),
		...state,
	} as S;
}

async function importLegacyPrWorkflowGateStateIfNeeded<
	S extends PrWorkflowPersistedStateBase,
>(
	directory: string,
	sessionID: string,
	allowSalvagedImport = false,
): Promise<S | null> {
	const filePath = workflowGateStatePath(directory, sessionID);
	let raw: string;
	try {
		raw = await fsp.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const legacy = allowSalvagedImport
		? ((
				await (
					await import('../hooks/pr-workflow-gate.js')
				).readPrWorkflowGateStateForRecovery(directory, sessionID)
			)?.state ?? null)
		: await readPrWorkflowGateStateFileFromDisk<S>(filePath, sessionID);
	if (!legacy) return null;
	const namespace = workflowGateStateCoordinationNamespace(sessionID);
	const outcome = importCoordinationOnce(
		directory,
		{
			source: workflowGateStateRelativePath(sessionID),
			sourceDigest: createHash('sha256').update(raw).digest('hex'),
			rowCount: 1,
			emptyNamespace: namespace,
		},
		() => {
			const result = transitionCoordinationState(directory, {
				namespace,
				entityKey: WORKFLOW_STATE_ENTITY_KEY,
				expectedRevision: null,
				generation: legacy.revision,
				status: workflowStateStatus(legacy),
				payload: JSON.stringify(legacy),
			});
			if (result.outcome !== 'applied') {
				throw new Error(
					`PR workflow gate state import failed: ${result.outcome}`,
				);
			}
		},
	);
	const authoritative = await readPrWorkflowGateStateFromCoordination<S>(
		directory,
		sessionID,
	);
	if (authoritative && outcome === 'imported') {
		await syncWorkflowGateShadowProjection(
			directory,
			sessionID,
			authoritative,
			{
				archiveLegacy: true,
			},
		);
	}
	return authoritative;
}

// ---------------------------------------------------------------------------
// CAS write
// ---------------------------------------------------------------------------

/** Persist one CAS-checked state replacement while the session lock is held. */
export async function writeStateWhileLocked<
	S extends PrWorkflowPersistedStateBase,
>(
	directory: string,
	state: S,
	options: { replaceWorkflowInstanceId?: string } = {},
): Promise<S> {
	const bound = requireCodec() as PrReviewStateCodec<S>;
	const validated = bound.parse(state);
	let currentAuthoritative = readPrWorkflowGateStateCoordinationRow<S>(
		directory,
		validated.sessionID,
	);
	let current = currentAuthoritative?.state ?? null;
	if (!current) {
		current = await readPrWorkflowGateStateFromDisk<S>(
			directory,
			validated.sessionID,
		);
		currentAuthoritative = readPrWorkflowGateStateCoordinationRow<S>(
			directory,
			validated.sessionID,
		);
	}
	if (
		current ? current.revision !== validated.revision : validated.revision !== 0
	) {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	if (
		current?.workflowInstanceId &&
		validated.workflowInstanceId !== current.workflowInstanceId &&
		options.replaceWorkflowInstanceId !== current.workflowInstanceId
	) {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	const nextState = bound.parse({
		...validated,
		revision: validated.revision + 1,
	});
	const result = transitionCoordinationState(directory, {
		namespace: workflowGateStateCoordinationNamespace(validated.sessionID),
		entityKey: WORKFLOW_STATE_ENTITY_KEY,
		expectedRevision: currentAuthoritative?.rowRevision ?? null,
		generation: nextState.revision,
		status: workflowStateStatus(nextState),
		payload: JSON.stringify(nextState),
	});
	if (result.outcome !== 'applied') {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	await syncWorkflowGateShadowProjection(
		directory,
		validated.sessionID,
		nextState,
		{ archiveLegacy: false },
	);
	rememberState(directory, nextState);
	return nextState;
}

/** Remove authoritative PR workflow state while the session mutation lock is held. */
export async function deleteStateWhileLocked(
	directory: string,
	sessionID: string,
	options: {
		expectedStateRevision?: number;
		allowSalvagedRead?: boolean;
	} = {},
): Promise<void> {
	const normalizedSessionID = normalizeSessionID(sessionID);
	let currentAuthoritative = readPrWorkflowGateStateCoordinationRow(
		directory,
		normalizedSessionID,
	);
	let recoveryState: PrWorkflowGateState | null = null;
	if (!currentAuthoritative) {
		if (options.allowSalvagedRead) {
			const { readPrWorkflowGateStateForRecovery } = await import(
				'../hooks/pr-workflow-gate.js'
			);
			recoveryState =
				(
					await readPrWorkflowGateStateForRecovery(
						directory,
						normalizedSessionID,
					)
				)?.state ?? null;
		}
		if (!recoveryState) {
			await readPrWorkflowGateStateFromDisk(directory, normalizedSessionID, {
				allowSalvagedImport: options.allowSalvagedRead === true,
			});
			currentAuthoritative = readPrWorkflowGateStateCoordinationRow(
				directory,
				normalizedSessionID,
			);
		}
	}
	const currentRevision =
		currentAuthoritative?.state.revision ?? recoveryState?.revision;
	if (
		options.expectedStateRevision !== undefined &&
		currentRevision !== options.expectedStateRevision
	) {
		throw new Error(
			'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
		);
	}
	if (currentAuthoritative) {
		const deleted = deleteCoordinationState(
			directory,
			workflowGateStateCoordinationNamespace(normalizedSessionID),
			WORKFLOW_STATE_ENTITY_KEY,
			currentAuthoritative.rowRevision,
		);
		if (!deleted) {
			throw new Error(
				'BLOCKED: PR workflow gate state changed concurrently; reload the active session state before retrying',
			);
		}
	}
	try {
		await fsp.rm(workflowGateStatePath(directory, normalizedSessionID), {
			force: true,
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	forgetTrackedPrWorkflowState(directory, normalizedSessionID);
}

// ---------------------------------------------------------------------------
// Checkout mutation lock
// ---------------------------------------------------------------------------

function checkoutMutationProjectKey(directory: string): string {
	return canonicalRootKeyFresh(directory);
}

/** A bounded checkout-mutation refusal that never permits unsafe late overlap. */
export class PrWorkflowCheckoutMutationTimeoutError extends Error {
	readonly code = 'PR_WORKFLOW_CHECKOUT_MUTATION_TIMEOUT' as const;
	readonly retryable = false as const;

	constructor(readonly phase: 'queue' | 'action') {
		super(
			phase === 'queue'
				? 'BLOCKED: timed out waiting for the active PR workflow checkout mutation; the existing owner still holds serialization and must settle before retrying'
				: 'BLOCKED: PR workflow checkout mutation exceeded its execution deadline; serialization remains held until the in-flight action actually settles',
		);
		this.name = 'PrWorkflowCheckoutMutationTimeoutError';
	}
}

type CheckoutActionOutcome<T> =
	| { status: 'fulfilled'; value: T }
	| { status: 'rejected'; error: unknown };

async function withCheckoutMutationDeadline<T>(
	promise: Promise<T>,
	phase: 'queue' | 'action',
): Promise<
	T | { status: 'timeout'; error: PrWorkflowCheckoutMutationTimeoutError }
> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<{
				status: 'timeout';
				error: PrWorkflowCheckoutMutationTimeoutError;
			}>((resolve) => {
				timeout = setTimeout(() => {
					resolve({
						status: 'timeout',
						error: new PrWorkflowCheckoutMutationTimeoutError(phase),
					});
				}, hooks.checkoutMutationActionTimeoutMs);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

/** Serialize project-wide checkout mutations before any session state lock. */
export async function withPrWorkflowCheckoutMutationLock<T>(
	directory: string,
	action: () => Promise<T>,
): Promise<T> {
	const key = checkoutMutationProjectKey(directory);
	const previous =
		pendingCheckoutMutationsByProject.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pendingCheckoutMutationsByProject.set(key, queued);
	const previousResult = await withCheckoutMutationDeadline(
		previous.then(() => ({ status: 'ready' as const })),
		'queue',
	);
	if (previousResult.status === 'timeout') {
		release();
		// Keep this resolved tail chained to the still-running owner so later
		// in-process waiters receive the same bounded typed refusal instead of
		// bypassing to the durable lock. Remove it only after the owner settles.
		void queued.then(() => {
			if (pendingCheckoutMutationsByProject.get(key) === queued) {
				pendingCheckoutMutationsByProject.delete(key);
			}
		});
		throw previousResult.error;
	}

	let lock: Awaited<ReturnType<typeof acquireCheckoutMutationLock>>;
	try {
		lock = await acquireCheckoutMutationLock(directory);
	} catch (error) {
		release();
		if (pendingCheckoutMutationsByProject.get(key) === queued) {
			pendingCheckoutMutationsByProject.delete(key);
		}
		throw error;
	}
	const actionOutcome: Promise<CheckoutActionOutcome<T>> = Promise.resolve()
		.then(action)
		.then(
			(value) => ({ status: 'fulfilled' as const, value }),
			(error: unknown) => ({ status: 'rejected' as const, error }),
		);
	const outcome = await withCheckoutMutationDeadline(actionOutcome, 'action');
	if (outcome.status === 'timeout') {
		// Promises are not cancellable. Returning the lock here would let a late
		// action mutate concurrently, so a retained owner task performs cleanup
		// only after the action truly settles.
		void actionOutcome.then(async () => {
			try {
				await releaseCheckoutMutationLock(lock);
			} catch {
				// Completed-owner recovery reclaims a persistently busy Windows lock.
			} finally {
				release();
				if (pendingCheckoutMutationsByProject.get(key) === queued) {
					pendingCheckoutMutationsByProject.delete(key);
				}
			}
		});
		throw outcome.error;
	}
	try {
		if (outcome.status === 'rejected') throw outcome.error;
		return outcome.value;
	} finally {
		try {
			await releaseCheckoutMutationLock(lock);
		} finally {
			release();
			if (pendingCheckoutMutationsByProject.get(key) === queued) {
				pendingCheckoutMutationsByProject.delete(key);
			}
		}
	}
}

async function acquireCheckoutMutationLock(
	directory: string,
): Promise<{ path: string; ownerToken: string }> {
	const lockPath = workflowCheckoutMutationLockPath(directory);
	const verifiedParent = await ensurePrWorkflowSafeParentDirectory(
		directory,
		lockPath,
	);
	for (let attempt = 0; attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await hooks.openCheckoutLock(lockPath);
			const lock = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: hooks.nowMs(),
			};
			let lockIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined;
			let writeError: unknown;
			try {
				const openedStat = await handle.stat({ bigint: true });
				lockIdentity = { dev: openedStat.dev, ino: openedStat.ino };
				lockIdentity = await assertOpenedSwarmFileIdentity(
					directory,
					lockPath,
					handle,
					verifiedParent,
					'PR workflow checkout mutation lock',
				);
				await hooks.beforeCheckoutLockWrite?.();
				await handle.writeFile(JSON.stringify(lock), 'utf-8');
			} catch (error) {
				writeError = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeError) {
				if (lockIdentity) {
					await removeCheckoutMutationLockByIdentity(
						directory,
						lockPath,
						lockIdentity,
						verifiedParent,
					);
				}
				throw writeError;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedCheckoutMutationLock(lockPath)) continue;
			if (attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS - 1) {
				await delay(STATE_MUTATION_LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR workflow checkout mutation is being handled by another process; retry after that checkout settles',
	);
}

async function releaseCheckoutMutationLock(lock: {
	path: string;
	ownerToken: string;
}): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
		try {
			if (await removeCheckoutMutationLockIfOwned(lock.path, lock.ownerToken)) {
				completedCheckoutLockOwners.delete(lock.path);
				return;
			}
			lastError = new Error(
				'PR workflow checkout mutation lock ownership changed before release',
			);
		} catch (error) {
			lastError = error;
		}
		if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
			await delay(RENAME_RETRY_DELAY_MS);
		}
	}
	rememberCompletedCheckoutLockOwner(lock.path, lock.ownerToken);
	throw lastError instanceof Error
		? lastError
		: new Error('PR workflow checkout mutation lock release failed');
}

async function reclaimAbandonedCheckoutMutationLock(
	lockPath: string,
): Promise<boolean> {
	const lock = await readCheckoutMutationLock(lockPath);
	if (lock) {
		if (
			lock.pid === process.pid &&
			completedCheckoutLockOwners.get(lockPath) === lock.ownerToken
		) {
			const removed = await removeCheckoutMutationLockIfOwned(
				lockPath,
				lock.ownerToken,
			);
			if (removed) completedCheckoutLockOwners.delete(lockPath);
			return removed;
		}
		if (hooks.isProcessAlive(lock.pid)) return false;
		return removeCheckoutMutationLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fsp.stat(lockPath);
		if (
			hooks.nowMs() - stat.mtimeMs <
			STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS
		) {
			return false;
		}
		await fsp.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readCheckoutMutationLock(
	lockPath: string,
): Promise<{ ownerToken: string; pid: number; createdAtMs: number } | null> {
	let raw: string;
	try {
		raw = await fsp.readFile(lockPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as { ownerToken?: unknown }).ownerToken === 'string' &&
			(parsed as { ownerToken: string }).ownerToken.length > 0 &&
			typeof (parsed as { pid?: unknown }).pid === 'number' &&
			Number.isInteger((parsed as { pid: number }).pid) &&
			(parsed as { pid: number }).pid > 0 &&
			typeof (parsed as { createdAtMs?: unknown }).createdAtMs === 'number' &&
			Number.isFinite((parsed as { createdAtMs: number }).createdAtMs)
		) {
			return parsed as { ownerToken: string; pid: number; createdAtMs: number };
		}
	} catch {
		// A crash between exclusive create and metadata write is recovered below.
	}
	return null;
}

async function removeCheckoutMutationLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readCheckoutMutationLock(lockPath);
	if (!lock || lock.ownerToken !== ownerToken) return false;
	try {
		await hooks.removeCheckoutLock(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

async function removeCheckoutMutationLockByIdentity(
	directory: string,
	lockPath: string,
	identity: Pick<BigIntStats, 'dev' | 'ino'>,
	verifiedParent: string,
): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt < WINDOWS_RENAME_MAX_RETRIES; attempt++) {
		try {
			await assertClosedSwarmFileIdentity(
				directory,
				lockPath,
				identity,
				verifiedParent,
				'PR workflow checkout mutation lock',
			);
			await hooks.removeCheckoutLock(lockPath);
			return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			lastError = error;
			if (attempt < WINDOWS_RENAME_MAX_RETRIES - 1) {
				await delay(RENAME_RETRY_DELAY_MS);
			}
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error('PR workflow checkout mutation lock cleanup failed');
}

function rememberCompletedCheckoutLockOwner(
	lockPath: string,
	ownerToken: string,
): void {
	completedCheckoutLockOwners.delete(lockPath);
	completedCheckoutLockOwners.set(lockPath, ownerToken);
	while (
		completedCheckoutLockOwners.size > MAX_COMPLETED_CHECKOUT_LOCK_OWNERS
	) {
		const oldest = completedCheckoutLockOwners.keys().next().value;
		if (oldest === undefined) break;
		completedCheckoutLockOwners.delete(oldest);
	}
}

// ---------------------------------------------------------------------------
// Session-state mutation lock
// ---------------------------------------------------------------------------

/** Serialize in-process mutations; the durable revision rejects stale callers. */
export async function withSessionStateMutation<T>(
	directory: string,
	sessionID: string,
	action: () => Promise<T>,
): Promise<T> {
	const key = stateCacheKey(directory, sessionID);
	const previous =
		pendingStateMutationsByProjectSession.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	pendingStateMutationsByProjectSession.set(key, queued);
	await previous;
	try {
		const lock = await acquireSessionStateMutationLock(directory, sessionID);
		try {
			return await action();
		} finally {
			await releaseSessionStateMutationLock(lock);
		}
	} finally {
		release();
		if (pendingStateMutationsByProjectSession.get(key) === queued) {
			pendingStateMutationsByProjectSession.delete(key);
		}
	}
}

async function acquireSessionStateMutationLock(
	directory: string,
	sessionID: string,
): Promise<{ path: string; ownerToken: string }> {
	const lockPath = workflowGateStateLockPath(directory, sessionID);
	const verifiedParent = await ensurePrWorkflowSafeParentDirectory(
		directory,
		lockPath,
	);
	for (let attempt = 0; attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			const handle = await fsp.open(lockPath, 'wx');
			const lock: SessionStateMutationLock = {
				ownerToken: randomUUID(),
				pid: process.pid,
				createdAtMs: hooks.nowMs(),
			};
			let writeError: unknown;
			try {
				await hooks.beforeSessionStateLockWrite?.();
				await assertOpenedSwarmFileIdentity(
					directory,
					lockPath,
					handle,
					verifiedParent,
					'PR workflow state mutation lock',
				);
				await handle.writeFile(JSON.stringify(lock), 'utf-8');
			} catch (error) {
				writeError = error;
			} finally {
				await handle.close().catch(() => undefined);
			}
			if (writeError) {
				await removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
				throw writeError;
			}
			return { path: lockPath, ownerToken: lock.ownerToken };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			if (await reclaimAbandonedSessionStateMutationLock(lockPath)) continue;
			if (attempt < STATE_MUTATION_LOCK_MAX_ATTEMPTS - 1) {
				await delay(STATE_MUTATION_LOCK_RETRY_DELAY_MS);
			}
		}
	}
	throw new Error(
		'BLOCKED: PR workflow gate state is being mutated by another process; retry after that session transition finishes',
	);
}

async function releaseSessionStateMutationLock(lock: {
	path: string;
	ownerToken: string;
}): Promise<void> {
	try {
		await removeSessionStateMutationLockIfOwned(lock.path, lock.ownerToken);
	} catch {
		// Best-effort cleanup; a crash-recovered lock is reclaimed by the next mutation.
	}
}

async function reclaimAbandonedSessionStateMutationLock(
	lockPath: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (lock) {
		if (hooks.isProcessAlive(lock.pid)) return false;
		return removeSessionStateMutationLockIfOwned(lockPath, lock.ownerToken);
	}
	try {
		const stat = await fsp.stat(lockPath);
		if (
			hooks.nowMs() - stat.mtimeMs <
			STATE_MUTATION_LOCK_UNINITIALIZED_STALE_MS
		) {
			return false;
		}
		await fsp.rm(lockPath, { force: true });
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
		throw error;
	}
}

async function readSessionStateMutationLock(
	lockPath: string,
): Promise<SessionStateMutationLock | null> {
	let raw: string;
	try {
		raw = await fsp.readFile(lockPath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as SessionStateMutationLock).ownerToken === 'string' &&
			(parsed as SessionStateMutationLock).ownerToken.length > 0 &&
			typeof (parsed as SessionStateMutationLock).pid === 'number' &&
			Number.isInteger((parsed as SessionStateMutationLock).pid) &&
			(parsed as SessionStateMutationLock).pid > 0 &&
			typeof (parsed as SessionStateMutationLock).createdAtMs === 'number' &&
			Number.isFinite((parsed as SessionStateMutationLock).createdAtMs)
		) {
			return parsed as SessionStateMutationLock;
		}
	} catch {
		// A crash between exclusive create and metadata write is recovered below.
	}
	return null;
}

async function removeSessionStateMutationLockIfOwned(
	lockPath: string,
	ownerToken: string,
): Promise<boolean> {
	const lock = await readSessionStateMutationLock(lockPath);
	if (!lock || lock.ownerToken !== ownerToken) return false;
	try {
		await fsp.rm(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}
