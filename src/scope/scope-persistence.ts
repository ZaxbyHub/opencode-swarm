/**
 * Scope persistence for #519 (v6.71.1 hotfix).
 *
 * Retains the legacy v1 `.swarm/scopes/scope-{taskId}.json` projection used by
 * worktree materialization, and persists authorization-capable v2 bindings as
 * exact identity/generation records. Durable v2 state is authoritative across
 * processes; memory is only a cache and can never revive a retired generation.
 *
 * Also exposes a fallback reader that reads `plan.json:phases[].tasks[].files_touched`
 * for the active task, so architect-authored plans become a durable scope source
 * even when `declare_scope` was never called (#496 root cause C mitigation).
 *
 * Read/write contract:
 *   - Atomic write via temp + rename (POSIX atomic on same filesystem).
 *   - File lock via proper-lockfile while writing.
 *   - Schema versioning: readers fail closed on unknown version.
 *   - Legacy v1 TTL: default 24h from declaredAt; expired projections return null.
 *   - V2 lifecycle: typed live/expired/revoked/ambiguous/overloaded decisions.
 *   - Symlink guards (defence in depth):
 *       * realpath containment check on `.swarm/scopes/` (closes parent-dir attack)
 *       * O_NOFOLLOW on both write-create and read-fd (closes leaf-file TOCTOU)
 *       * taskId-in-file must match the filename (closes cross-pollination)
 *       * declaredAt must be <= now (closes future-timestamp attack)
 *       * files array capped at MAX_FILES_PER_SCOPE (DoS cap)
 *       * plan.json size capped at MAX_PLAN_BYTES (DoS cap)
 *       * Windows reserved device names rejected (CON, NUL, LPT1, …)
 *
 * AUTHORITY BOUNDARY:
 *   - Direct-write tools and statically detected shell/interpreter write targets
 *     resolve through the same active Task-correlated binding.
 *   - A coder write with no binding or an unverifiable target fails closed with
 *     SCOPE_NOT_DECLARED/SCOPE_VIOLATION. Shell syntax is not an authority bypass.
 *   - This is command-level containment, not an operating-system syscall sandbox.
 *
 * RESIDUAL RISKS:
 *   1. Platform-portability of legacy v1 symlink guards:
 *        - realpath resolves POSIX symlinks and Windows junctions, but the
 *          Windows behaviour is not covered by CI (Linux-only test matrix).
 *        - O_NOFOLLOW is a no-op on Windows (falls back to 0). The realpath
 *          containment check on `.swarm/scopes/` remains the primary guard
 *          on that platform; leaf-file TOCTOU on Windows is not closed.
 *   2. Legacy v1 temp-file leak: a crash between atomic-write steps can leave
 *      temporary projection files. V2 lifecycle maintenance is bounded and
 *      prunes settled receipts, tombstones, sidecars, and retirement intents.
 *
 * NOT a standalone syscall security boundary. Shell-write detection and the
 * central write-target resolver provide command-level interception; this module
 * supplies the durable, identity-bound authority they consume.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { type Plan, PlanSchema } from '../config/plan-schema';
import {
	type CoordinationState,
	deleteCoordinationStateWithinTransaction,
	getProjectDb,
	importCoordinationOnce,
	listCoordinationStateRowsRaw,
	listCoordinationStates,
	MAX_COORDINATION_STATE_LIST_ROWS,
	transitionCoordinationState,
	transitionCoordinationStateWithinTransaction,
	withCoordinationTransaction,
} from '../db';
import { getCoordinationStateRaw } from '../db/coordination-store.js';
import { appendCoreEventSync } from '../events/core-events.js';
import { computePlanStructureHash } from '../plan/ledger';
import { derivePlanId } from '../plan/utils';
import {
	atomicWriteSwarmFile,
	atomicWriteSwarmFileSync,
} from '../utils/atomic-write';
import {
	canonicalExistingFilesystemPath,
	legacyCanonicalExistingFilesystemPath,
} from '../utils/filesystem-identity.js';
import { assertProjectRoot } from '../utils/project-boundary';
import {
	canonicalWorkspaceIdentity,
	clearExactScopeBinding,
	clearScopeBindings,
	clearSweepTombstoneForRevival,
	createClaimedScopeBinding,
	DEFAULT_SCOPE_BINDING_TTL_MS,
	getActiveScopeBindingsForSession,
	hasDeliberateScopeBindingDenyOverlay,
	hasScopeBindingDenyOverlay,
	installFailedRevocationOverlay,
	installScopeBindingRetirementIntent,
	installScopeBindingTombstone,
	isScopeBindingIdentity,
	MAX_PENDING_SCOPE_BINDINGS,
	MAX_SCOPE_BINDING_AGE_MS,
	normalizeScopeFiles,
	registerScopeBinding,
	type ScopeBinding,
	type ScopeBindingAdmissionResult,
	updateExactScopeBinding,
} from './scope-binding';

const SCOPE_SCHEMA_VERSION = 1 as const;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const SCOPES_DIR = '.swarm/scopes';
const MAX_FILES_PER_SCOPE = 10_000;
const MAX_PLAN_BYTES = 10 * 1024 * 1024; // 10 MiB — plan.json size cap
const MAX_SCOPE_BYTES = 2 * 1024 * 1024; // 2 MiB — scope file size cap
const MAX_BINDING_FILES_TO_SCAN = 10_000;
const MAX_TOMBSTONE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DURABLE_TOMBSTONES = 256;
const SCOPE_BINDING_COORDINATION_NAMESPACE = 'scope-binding';
const SCOPE_BINDING_COORDINATION_IMPORT_SOURCE = 'scope-binding-v2';
let liveBindingCapacity = MAX_PENDING_SCOPE_BINDINGS;
let bindingFileScanCapacity = MAX_BINDING_FILES_TO_SCAN;
let maintenanceFileScanCapacity = MAX_BINDING_FILES_TO_SCAN * 2;
const MAX_MAINTENANCE_JOBS = 64;
const maintenanceJobs = new Map<string, Promise<void>>();
// ---- Compact exact-generation deny ledger (issues #3889/#3900, design C) ----
// One coordination row per workspace holding a bounded map of per-generation
// deny evidence, separated from the authoritative scope-binding scan so
// terminal rows can be collected immediately while cross-runtime deny
// evidence survives (plan v3/v4/v4b/v4c/v4d; critic rounds 1-7).
const SCOPE_BINDING_DENY_NAMESPACE = 'scope-binding-deny';
const DENY_LEDGER_ENTITY_KEY = 'deny-ledger';
/** FIFO cap for TERMINAL entries only (disclosed bound; pending never evicted). */
const MAX_DENY_LEDGER_TERMINAL_ENTRIES = 2048;
/** Terminal entries prunable once no in-memory authority can remain alive. */
const DENY_LEDGER_TERMINAL_TTL_MS = MAX_SCOPE_BINDING_AGE_MS;

interface ScopeDenyLedgerEntry {
	bindingId: string;
	kind: 'terminal' | 'admission-pending';
	revision: number;
	at: number;
	/** The retired/claimed row's own expiresAt — pending terminalization bound. */
	rowExpiresAt: number;
}

interface ScopeDenyLedger {
	version: 1;
	entries: Record<string, ScopeDenyLedgerEntry>;
}

type DenyLedgerRead =
	| { status: 'absent' }
	| { status: 'valid'; ledger: ScopeDenyLedger }
	| { status: 'unreadable'; reason: string };

interface RawLedgerRow {
	entityKey: string;
	payload: string;
	revision: number;
	generation: number;
}

function parseDenyLedgerPayload(payload: string): ScopeDenyLedger | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	const record = parsed as { version?: unknown; entries?: unknown };
	if (
		record.version !== 1 ||
		typeof record.entries !== 'object' ||
		record.entries === null
	)
		return null;
	const entries: Record<string, ScopeDenyLedgerEntry> = {};
	for (const [key, value] of Object.entries(record.entries)) {
		if (typeof value !== 'object' || value === null) return null;
		const entry = value as Partial<ScopeDenyLedgerEntry>;
		if (
			typeof entry.bindingId !== 'string' ||
			(entry.kind !== 'terminal' && entry.kind !== 'admission-pending') ||
			!Number.isSafeInteger(entry.revision) ||
			typeof entry.at !== 'number' ||
			typeof entry.rowExpiresAt !== 'number'
		)
			return null;
		entries[key] = {
			bindingId: entry.bindingId,
			kind: entry.kind as ScopeDenyLedgerEntry['kind'],
			revision: entry.revision as number,
			at: entry.at as number,
			rowExpiresAt: entry.rowExpiresAt as number,
		};
	}
	return { version: 1, entries };
}

/** Tri-state read (raw payload, own validation — rowToState never sees it). */
function readDenyLedgerRaw(rawRows: readonly RawLedgerRow[]): {
	read: DenyLedgerRead;
	row?: RawLedgerRow;
} {
	const ledgerRow = rawRows.find(
		(row) => row.entityKey === DENY_LEDGER_ENTITY_KEY,
	);
	if (!ledgerRow) return { read: { status: 'absent' } };
	const ledger = parseDenyLedgerPayload(ledgerRow.payload);
	if (!ledger)
		return {
			read: {
				status: 'unreadable',
				reason: 'The scope deny ledger payload is malformed.',
			},
			row: ledgerRow,
		};
	return { read: { status: 'valid', ledger }, row: ledgerRow };
}

/**
 * The deny ledger is one fixed-key row, read by that key.
 *
 * The read is raw: the single-row reader validates nothing, so the ledger's
 * own validation above is the only classifier and a database failure
 * propagates unchanged. It also prepares no statement of its own. On Windows
 * this Bun release keeps a closed connection's database file locked until
 * garbage collection once more than a few dozen statements have been prepared,
 * so one extra statement in a flow is enough to strand swarm.db at teardown;
 * the by-key select is the one the ledger's own CAS transition reads with.
 */
function readDenyLedgerWithRow(directory: string): {
	read: DenyLedgerRead;
	row?: RawLedgerRow;
} {
	const state = getCoordinationStateRaw(
		directory,
		SCOPE_BINDING_DENY_NAMESPACE,
		DENY_LEDGER_ENTITY_KEY,
	);
	const rawRows: RawLedgerRow[] = state
		? [
				{
					entityKey: state.entityKey,
					payload: state.payload,
					revision: state.revision,
					generation: state.generation,
				},
			]
		: [];
	return readDenyLedgerRaw(rawRows);
}

function readDenyLedger(directory: string): DenyLedgerRead {
	return readDenyLedgerWithRow(directory).read;
}

/**
 * Ledger maintenance, kind-aware (v4c R5-2 / v4d): TERMINAL entries are
 * pruned past DENY_LEDGER_TERMINAL_TTL_MS and FIFO-capped at
 * MAX_DENY_LEDGER_TERMINAL_ENTRIES; admission-pending entries are never
 * evicted here — released only by compare-and-remove or the v4d
 * revival-window terminalization.
 */
function pruneDenyLedgerEntries(
	entries: Record<string, ScopeDenyLedgerEntry>,
	now: number,
): Record<string, ScopeDenyLedgerEntry> {
	const kept: Record<string, ScopeDenyLedgerEntry> = {};
	let terminalCount = 0;
	// First pass keeps pending entries and unexpired terminal entries.
	for (const [generationId, entry] of Object.entries(entries)) {
		if (entry.kind === 'admission-pending') {
			kept[generationId] = entry;
			continue;
		}
		if (now - entry.at <= DENY_LEDGER_TERMINAL_TTL_MS) {
			kept[generationId] = entry;
			terminalCount += 1;
		}
	}
	// Second pass applies the terminal FIFO cap (oldest first by `at`).
	if (terminalCount > MAX_DENY_LEDGER_TERMINAL_ENTRIES) {
		const terminalIds = Object.entries(kept)
			.filter(([, entry]) => entry.kind === 'terminal')
			.sort((left, right) => left[1].at - right[1].at)
			.map(([generationId]) => generationId);
		const overflow = terminalCount - MAX_DENY_LEDGER_TERMINAL_ENTRIES;
		for (let index = 0; index < overflow; index += 1) {
			delete kept[terminalIds[index]!];
		}
	}
	return kept;
}

/**
 * Upsert the deny ledger inside a caller-owned coordination transaction.
 * The raw row is re-read INSIDE the transaction (optimistic concurrency via
 * the coordination generation token), so concurrent ledger writers serialize.
 */
function writeDenyLedgerWithinTransaction(
	directory: string,
	mutate: (entries: Record<string, ScopeDenyLedgerEntry>) => void,
): ScopePersistenceFailure | null {
	const { read, row } = readDenyLedgerWithRow(directory);
	if (read.status === 'unreadable')
		return persistenceFailure(read.reason) as ScopePersistenceFailure;
	const entries: Record<string, ScopeDenyLedgerEntry> =
		read.status === 'valid' ? { ...read.ledger.entries } : {};
	mutate(entries);
	const pruned = pruneDenyLedgerEntries(entries, Date.now());
	const payload = JSON.stringify({
		version: 1,
		entries: pruned,
	} satisfies ScopeDenyLedger);
	const transition = transitionCoordinationStateWithinTransaction(directory, {
		namespace: SCOPE_BINDING_DENY_NAMESPACE,
		entityKey: DENY_LEDGER_ENTITY_KEY,
		generation: (row?.generation ?? 0) + 1,
		expectedRevision: row ? row.revision : null,
		status: 'ok',
		payload,
	});
	if (transition.outcome !== 'applied')
		return persistenceFailure(
			`Scope deny ledger transition failed: ${transition.outcome}`,
		) as ScopePersistenceFailure;
	return null;
}

/** v4c R5-3: remove a pending entry only when it is still THE pending entry. */
function compareAndRemovePendingWithinTransaction(
	entries: Record<string, ScopeDenyLedgerEntry>,
	generationId: string,
	revision: number,
): void {
	const entry = entries[generationId];
	if (
		entry &&
		entry.kind === 'admission-pending' &&
		entry.revision === revision
	) {
		delete entries[generationId];
	}
}

/** Post-admission pending release (own small transaction; failure = disclosed false deny). */
function releaseAdmissionPending(
	directory: string,
	generationId: string,
	revision: number,
): void {
	try {
		withCoordinationTransaction(directory, () => {
			const failure = writeDenyLedgerWithinTransaction(directory, (entries) => {
				compareAndRemovePendingWithinTransaction(
					entries,
					generationId,
					revision,
				);
			});
			if (failure && !failure.ok) throw new Error(failure.message);
		});
	} catch {
		// Fail-closed: the pending entry stays and denies this generation in
		// every runtime until a fresh declare creates an unblocked generation.
	}
}

/**
 * True when the durable row at a binding's key and revision is not the row
 * the caller is holding.
 *
 * The retirement delete matches namespace, key and revision only, and a
 * fresh insert restarts the revision at 1. So a row that another process
 * deletes and re-inserts under the same key between a caller's read and its
 * retirement (the reset sweep reads a page, then acts on it) would be
 * retired as if it were the row the caller read. Generation ids are random
 * and the writer refuses a colliding identity while the row exists, so no
 * production writer creates such a row; this is the fail-closed backstop.
 *
 * What it establishes depends on what the caller knows:
 *   - A caller that passes the payload it observed (`expectedPayload`) is
 *     refused anything but that exact content: key, revision and payload.
 *     This holds whatever the row carries — a different binding id, no
 *     binding id at all, or a payload that does not parse.
 *   - A caller that passes no payload is refused only a row that NAMES a
 *     different binding by its binding id. A row that carries no binding id
 *     (a legacy row) or whose payload cannot be parsed has no identity to
 *     compare and is left to the key-and-revision check, as before.
 *
 * Must run inside the caller's coordination transaction, so nothing can
 * change the row between this read and the delete.
 */
function durableRowIsNotTheCallers(
	directory: string,
	binding: Pick<ScopeBinding, 'bindingId' | 'generationId' | 'revision'>,
	expectedPayload: string | undefined,
): boolean {
	const row = getCoordinationStateRaw(
		directory,
		SCOPE_BINDING_COORDINATION_NAMESPACE,
		binding.generationId,
	);
	// Absent, or at another revision: the delete's own revision check reports
	// that, exactly as before.
	if (!row || row.revision !== binding.revision) return false;
	if (expectedPayload !== undefined) return row.payload !== expectedPayload;
	if (typeof binding.bindingId !== 'string' || binding.bindingId.length === 0)
		return false;
	let payload: unknown;
	try {
		payload = JSON.parse(row.payload);
	} catch {
		return false;
	}
	if (payload === null || typeof payload !== 'object') return false;
	const durableBindingId = (payload as Record<string, unknown>).bindingId;
	return (
		typeof durableBindingId === 'string' &&
		durableBindingId.length > 0 &&
		durableBindingId !== binding.bindingId
	);
}

/**
 * SHARED TRANSACTIONAL TERMINAL SINK (v4 item 5): ledger entry + row
 * deletion + in-memory exact tombstone. Must run inside a caller-owned
 * coordination transaction. Returns a failure to abort the transaction.
 *
 * A caller that passes `expectedPayload` — the payload it observed — retires
 * that content exactly or nothing. Any caller is refused a row that names a
 * different binding by its binding id. See `durableRowIsNotTheCallers` for
 * what is and is not established without a payload.
 */
function retireScopeBindingGenerationWithinTransaction(
	directory: string,
	binding: Pick<
		ScopeBinding,
		'bindingId' | 'generationId' | 'revision' | 'expiresAt'
	>,
	_kind: 'revoked' | 'superseded' | 'expired',
	expectedPayload?: string,
): ScopePersistenceFailure | null {
	if (durableRowIsNotTheCallers(directory, binding, expectedPayload))
		return persistenceFailure(
			'Terminal retirement refused: the durable row is not the row the caller named.',
		) as ScopePersistenceFailure;
	const now = Date.now();
	const ledgerFailure = writeDenyLedgerWithinTransaction(
		directory,
		(entries) => {
			entries[binding.generationId] = {
				bindingId: binding.bindingId,
				kind: 'terminal',
				revision: binding.revision + 1,
				at: now,
				rowExpiresAt: binding.expiresAt,
			};
		},
	);
	if (ledgerFailure) return ledgerFailure;
	const deleted = deleteCoordinationStateWithinTransaction(
		directory,
		SCOPE_BINDING_COORDINATION_NAMESPACE,
		binding.generationId,
		binding.revision,
	);
	if (!deleted)
		return persistenceFailure(
			'Terminal retirement delete did not match the exact coordination row.',
		) as ScopePersistenceFailure;
	return null;
}

/** Record admission-pending deny evidence for a freshly committed successor. */
function markAdmissionPendingWithinTransaction(
	directory: string,
	binding: Pick<
		ScopeBinding,
		'bindingId' | 'generationId' | 'revision' | 'expiresAt'
	>,
): ScopePersistenceFailure | null {
	const now = Date.now();
	const ledgerFailure = writeDenyLedgerWithinTransaction(
		directory,
		(entries) => {
			entries[binding.generationId] = {
				bindingId: binding.bindingId,
				kind: 'admission-pending',
				revision: binding.revision,
				at: now,
				rowExpiresAt: binding.expiresAt,
			};
		},
	);
	if (ledgerFailure) return ledgerFailure;
	return null;
}
// ---- end deny ledger ----

const lockfileWithSync = lockfile as typeof lockfile & {
	lockSync(
		file: string,
		options: {
			stale: number;
			retries?:
				| number
				| { retries: number; minTimeout?: number; maxTimeout?: number };
			realpath: boolean;
		},
	): () => void;
};

export type ScopePersistenceCode =
	| 'SCOPE_NOT_DECLARED'
	| 'SCOPE_BINDING_PERSISTENCE_FAILED'
	| 'SCOPE_BINDING_CAPACITY'
	| 'SCOPE_BINDING_ALREADY_CLAIMED'
	| 'SCOPE_BINDING_AMBIGUOUS'
	| 'SCOPE_BINDING_EXPIRED'
	| 'SCOPE_BINDING_STORE_OVERLOADED'
	| 'SCOPE_BINDING_STALE';

export type ScopePersistenceResult<T = ScopeBinding> =
	| { ok: true; value: T }
	| { ok: false; code: ScopePersistenceCode; message: string };

type ScopePersistenceFailure = Exclude<ScopePersistenceResult, { ok: true }>;

class ScopeCoordinationAbort extends Error {
	constructor(readonly failure: ScopePersistenceFailure) {
		super(failure.message);
		this.name = 'ScopeCoordinationAbort';
	}
}

export type DurableScopeBindingResolution =
	| { status: 'found'; binding: ScopeBinding }
	| { status: 'expired'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'ambiguous'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'overloaded' }
	| { status: 'store_unreadable' }
	| { status: 'not_declared' };

// Windows reserved device names. Defence-in-depth — declare-scope already
// constrains taskId to N.M[.P], but this module is also imported by readers
// that may be fed raw input.
const WINDOWS_RESERVED = new Set([
	'CON',
	'PRN',
	'AUX',
	'NUL',
	'COM1',
	'COM2',
	'COM3',
	'COM4',
	'COM5',
	'COM6',
	'COM7',
	'COM8',
	'COM9',
	'LPT1',
	'LPT2',
	'LPT3',
	'LPT4',
	'LPT5',
	'LPT6',
	'LPT7',
	'LPT8',
	'LPT9',
]);

export interface PersistedScope {
	version: typeof SCOPE_SCHEMA_VERSION;
	taskId: string;
	declaredAt: number;
	expiresAt: number;
	files: string[];
}

export type PersistedScopeBinding = ScopeBinding;

function getScopesDir(directory: string): string {
	return path.join(directory, SCOPES_DIR);
}

function normalizePathForComparison(value: string): string {
	const normalized = path.resolve(value);
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * Task IDs must match the same format enforced by declare-scope.ts
 * (alphanumeric + dot + hyphen, no path separators). Keeps file names safe.
 * Additionally rejects Windows reserved device names so `scope-CON.json`
 * cannot open the console on Windows hosts.
 */
function isSafeTaskId(taskId: string): boolean {
	if (typeof taskId !== 'string') return false;
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(taskId)) return false;
	// Trailing dot makes Windows treat `CON.` as `CON`.
	const head = taskId.replace(/\.+$/, '').split('.')[0].toUpperCase();
	if (WINDOWS_RESERVED.has(head)) return false;
	return true;
}

/**
 * Verify `.swarm/scopes/` is a real directory inside the workspace, not a
 * symlink escaping the workspace. Closes the parent-directory symlink bypass
 * that would otherwise let `lstat` on the leaf file see a legit file inside an
 * attacker-controlled directory.
 */
function isScopesDirSafe(directory: string, scopesDir: string): boolean {
	try {
		const resolvedWorkspace = fs.realpathSync(directory);
		const expectedSwarmDir = path.join(resolvedWorkspace, '.swarm');
		const expectedScopesDir = path.join(expectedSwarmDir, 'scopes');
		const swarmStat = fs.lstatSync(expectedSwarmDir);
		const scopesStat = fs.lstatSync(expectedScopesDir);
		if (
			!swarmStat.isDirectory() ||
			swarmStat.isSymbolicLink() ||
			!scopesStat.isDirectory() ||
			scopesStat.isSymbolicLink()
		)
			return false;

		const resolvedScopes = fs.realpathSync(scopesDir);
		if (
			normalizePathForComparison(resolvedScopes) !==
			normalizePathForComparison(expectedScopesDir)
		)
			return false;
		const rel = path.relative(resolvedWorkspace, resolvedScopes);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	} catch {
		return false;
	}
}

/**
 * Resolve a scope file that is safe to unlink. Cleanup is fail-closed because
 * following a swapped `.swarm/scopes` junction could delete an attacker-chosen
 * file outside the workspace. The canonical workspace path avoids traversing a
 * caller-supplied workspace alias, and both parents plus the leaf must remain
 * ordinary, non-symlink filesystem entries immediately before unlink.
 */
function resolveSafeScopeFileForUnlink(
	directory: string,
	targetPath: string,
): string | null {
	try {
		const resolvedWorkspace = fs.realpathSync(directory);
		const scopesDir = path.join(resolvedWorkspace, SCOPES_DIR);
		if (!isScopesDirSafe(resolvedWorkspace, scopesDir)) return null;

		const candidate = path.resolve(targetPath);
		const resolvedCandidate = fs.realpathSync(candidate);
		// On macOS, os.tmpdir() resolves through a symlink (/var -> /private/var),
		// so compare realpaths consistently. The leaf-symlink check below (lstat)
		// still rejects a symlinked file itself; only the parent-directory
		// resolution is allowed to differ.
		if (
			normalizePathForComparison(path.dirname(resolvedCandidate)) !==
			normalizePathForComparison(scopesDir)
		)
			return null;

		const relative = path.relative(resolvedWorkspace, resolvedCandidate);
		if (
			relative.length === 0 ||
			relative === '..' ||
			relative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(relative)
		)
			return null;

		const leafStat = fs.lstatSync(candidate);
		if (!leafStat.isFile() || leafStat.isSymbolicLink()) return null;

		// Revalidate both parent and leaf immediately before the caller unlinks.
		if (!isScopesDirSafe(resolvedWorkspace, scopesDir)) return null;
		const finalResolvedCandidate = fs.realpathSync(candidate);
		const finalLeafStat = fs.lstatSync(candidate);
		if (
			normalizePathForComparison(path.dirname(finalResolvedCandidate)) !==
				normalizePathForComparison(scopesDir) ||
			!finalLeafStat.isFile() ||
			finalLeafStat.isSymbolicLink() ||
			finalLeafStat.dev !== leafStat.dev ||
			finalLeafStat.ino !== leafStat.ino
		)
			return null;
		return candidate;
	} catch {
		return null;
	}
}

function getScopeFilePath(directory: string, taskId: string): string {
	if (!isSafeTaskId(taskId)) {
		throw new Error(`Invalid taskId for scope persistence: ${taskId}`);
	}
	return path.join(getScopesDir(directory), `scope-${taskId}.json`);
}

function getLegacyBindingFilePath(
	directory: string,
	taskId: string,
	ownerSessionId: string,
): string {
	if (!isSafeTaskId(taskId) || !ownerSessionId.trim()) {
		throw new Error('Invalid identity for scope binding persistence');
	}
	const ownerHash = createHash('sha256')
		.update(ownerSessionId)
		.digest('hex')
		.slice(0, 24);
	return path.join(
		getScopesDir(directory),
		`binding-${taskId}-${ownerHash}.json`,
	);
}

function getBindingFilePath(
	directory: string,
	binding: Pick<ScopeBinding, 'taskId' | 'bindingId' | 'generationId'>,
): string {
	if (
		!isSafeTaskId(binding.taskId) ||
		!isScopeBindingIdentity(binding.bindingId) ||
		!isScopeBindingIdentity(binding.generationId)
	)
		throw new Error('Invalid exact identity for scope binding persistence');
	return path.join(
		getScopesDir(directory),
		`binding-${binding.taskId}-${binding.bindingId}-${binding.generationId}.json`,
	);
}

/** Stable sidecar lock. Locking the data file itself must never recreate it. */
function getGenerationLockPath(bindingPath: string): string {
	return `${bindingPath}.generation-lock`;
}

function getRetirementIntentPath(bindingPath: string): string {
	return `${bindingPath}.retirement-intent`;
}

function hasDurableRetirementIntent(
	bindingPath: string,
	binding: Pick<ScopeBinding, 'bindingId' | 'generationId'>,
): boolean {
	const raw = readBoundedFile(getRetirementIntentPath(bindingPath));
	if (!raw) return false;
	try {
		const intent = JSON.parse(raw) as {
			bindingId?: unknown;
			generationId?: unknown;
		};
		return (
			intent.bindingId === binding.bindingId &&
			intent.generationId === binding.generationId
		);
	} catch {
		return false;
	}
}

function ensureLockTargetSync(targetPath: string): boolean {
	try {
		const scopesDir = path.dirname(targetPath);
		const swarmDir = path.dirname(scopesDir);
		if (
			path.basename(scopesDir) !== 'scopes' ||
			path.basename(swarmDir) !== '.swarm'
		)
			return false;
		assertProjectRoot(path.dirname(swarmDir));
		fs.mkdirSync(path.dirname(targetPath), { recursive: true });
		const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		const fd = fs.openSync(
			targetPath,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | nofollow,
		);
		fs.closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function readBoundedFile(filePath: string): string | null {
	const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | nofollow);
	} catch {
		return null;
	}
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SCOPE_BYTES)
			return null;
		const buffer = Buffer.alloc(stat.size);
		fs.readSync(fd, buffer, 0, stat.size, 0);
		return buffer.toString('utf8');
	} catch {
		return null;
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
	}
}

function scopeBindingArchivePath(filePath: string): string {
	return `${filePath}.imported`;
}

function collisionSafeScopeBindingArchivePath(filePath: string): string {
	const canonical = scopeBindingArchivePath(filePath);
	if (!fs.existsSync(canonical)) return canonical;
	for (let suffix = 1; suffix <= 10_000; suffix += 1) {
		const candidate = `${canonical}.${suffix}`;
		if (!fs.existsSync(candidate)) return candidate;
	}
	throw new Error(
		`No collision-safe archive path available for ${path.basename(filePath)}.`,
	);
}

function scopeBindingShadowPayload(binding: ScopeBinding): string {
	return JSON.stringify(binding, null, 2);
}

function coordinationScopeEntityKey(
	binding: Pick<ScopeBinding, 'generationId'>,
): string {
	return binding.generationId;
}

function parseCoordinationScopeBinding(
	directory: string,
	row: CoordinationState,
): ScopeBinding | null {
	try {
		const binding = validateScopeBindingPayload(
			directory,
			JSON.parse(row.payload) as Partial<ScopeBinding>,
		);
		if (
			!binding ||
			binding.generationId !== row.entityKey ||
			binding.revision !== row.revision ||
			binding.lifecycleState !== row.status
		) {
			return null;
		}
		return binding;
	} catch {
		return null;
	}
}

function transitionScopeBindingState(
	directory: string,
	binding: ScopeBinding,
	expectedRevision: number | null,
): ScopePersistenceResult {
	const payload = scopeBindingShadowPayload(binding);
	const idempotencyKey = createHash('sha256')
		.update(
			`${binding.bindingId}\0${binding.generationId}\0${binding.revision}\0${binding.lifecycleState}\0${payload}`,
		)
		.digest('hex');
	try {
		const result = transitionCoordinationState(directory, {
			namespace: SCOPE_BINDING_COORDINATION_NAMESPACE,
			entityKey: coordinationScopeEntityKey(binding),
			expectedRevision,
			generation: 1,
			status: binding.lifecycleState,
			payload,
			event: {
				streamId: `scope-binding:${binding.bindingId}`,
				idempotencyKey,
				eventType: binding.lifecycleState,
				payload,
			},
		});
		if (result.outcome !== 'applied' && result.outcome !== 'duplicate') {
			return {
				ok: false,
				code:
					result.outcome === 'revision_conflict' ||
					result.outcome === 'stale_generation'
						? 'SCOPE_BINDING_STALE'
						: 'SCOPE_BINDING_PERSISTENCE_FAILED',
				message: `Scope binding transition failed: ${result.outcome}.`,
			};
		}
		const persisted =
			result.state && parseCoordinationScopeBinding(directory, result.state);
		return persisted
			? { ok: true, value: persisted }
			: persistenceFailure(
					'Scope binding transition could not be re-read from coordination state.',
				);
	} catch (error) {
		return persistenceFailure(
			`Scope binding transition failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

/**
 * Scope replacement rollback owns one coordination transaction across the
 * successor revocation and every predecessor restore. Re-entering the public
 * transition helper would create nested SQLite transaction scopes that cannot
 * make that whole compensation batch atomic.
 */
function transitionScopeBindingStateWithinTransaction(
	directory: string,
	binding: ScopeBinding,
	expectedRevision: number | null,
): ScopePersistenceResult {
	const payload = scopeBindingShadowPayload(binding);
	const idempotencyKey = createHash('sha256')
		.update(
			`${binding.bindingId}\0${binding.generationId}\0${binding.revision}\0${binding.lifecycleState}\0${payload}`,
		)
		.digest('hex');
	try {
		const result = transitionCoordinationStateWithinTransaction(directory, {
			namespace: SCOPE_BINDING_COORDINATION_NAMESPACE,
			entityKey: coordinationScopeEntityKey(binding),
			expectedRevision,
			generation: 1,
			status: binding.lifecycleState,
			payload,
			event: {
				streamId: `scope-binding:${binding.bindingId}`,
				idempotencyKey,
				eventType: binding.lifecycleState,
				payload,
			},
		});
		if (result.outcome !== 'applied' && result.outcome !== 'duplicate') {
			return {
				ok: false,
				code:
					result.outcome === 'revision_conflict' ||
					result.outcome === 'stale_generation'
						? 'SCOPE_BINDING_STALE'
						: 'SCOPE_BINDING_PERSISTENCE_FAILED',
				message: `Scope binding transition failed: ${result.outcome}.`,
			};
		}
		const persisted =
			result.state && parseCoordinationScopeBinding(directory, result.state);
		return persisted
			? { ok: true, value: persisted }
			: persistenceFailure(
					'Scope binding transition could not be re-read from coordination state.',
				);
	} catch (error) {
		return persistenceFailure(
			`Scope binding transition failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

function coordinationTimestampFromMs(value: number, label: string): string {
	if (!Number.isFinite(value)) {
		throw new Error(`${label} must be a finite epoch-millisecond timestamp.`);
	}
	const iso = new Date(value).toISOString();
	if (Number.isNaN(Date.parse(iso))) {
		throw new Error(`${label} must be a valid epoch-millisecond timestamp.`);
	}
	return iso;
}

function importScopeBindingStateRows(
	directory: string,
	bindings: readonly ScopeBinding[],
): void {
	const db = getProjectDb(directory);
	for (const binding of bindings) {
		if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) {
			throw new Error(
				`Legacy binding ${binding.generationId} has invalid revision ${binding.revision}.`,
			);
		}
		db.run(
			`INSERT INTO coordination_state
			 (namespace, entity_key, revision, generation, status, payload, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				SCOPE_BINDING_COORDINATION_NAMESPACE,
				coordinationScopeEntityKey(binding),
				binding.revision,
				1,
				binding.lifecycleState,
				scopeBindingShadowPayload(binding),
				coordinationTimestampFromMs(binding.updatedAt, 'binding.updatedAt'),
			],
		);
	}
}

/** Best-effort shadow removal for sink-retired generations (authority lives in the coordination row). */
function removeScopeBindingShadow(
	directory: string,
	binding: Pick<ScopeBinding, 'taskId' | 'bindingId' | 'generationId'>,
): void {
	try {
		const filePath = resolveSafeScopeFileForUnlink(
			directory,
			getBindingFilePath(directory, { ...binding } as ScopeBinding),
		);
		if (filePath) fs.unlinkSync(filePath);
	} catch {
		/* Shadow cleanup is best-effort: if the file delete fails (for
		   example a Windows lock), the file can be re-imported as a live
		   row by the next read. Two backstops prevent it from restoring
		   authority: ensureScopeBindingAuthorityImported skips any
		   generationId that carries a terminal deny-ledger entry, and
		   readAllAuthoritativeScopeBindings drops such rows too. The
		   leftover file is, however, never retried by the pruner. */
	}
}

function writeScopeBindingShadow(
	directory: string,
	binding: ScopeBinding,
): void {
	try {
		const scopesDir = getScopesDir(directory);
		fs.mkdirSync(scopesDir, { recursive: true });
		if (!isScopesDirSafe(directory, scopesDir)) return;
		atomicWriteSync(
			getBindingFilePath(directory, binding),
			scopeBindingShadowPayload(binding),
		);
	} catch {
		/* compatibility projection only */
	}
}

function archiveImportedScopeAuthorityFiles(paths: readonly string[]): void {
	for (const filePath of paths) {
		try {
			if (!fs.existsSync(filePath)) continue;
			const archivedPath = collisionSafeScopeBindingArchivePath(filePath);
			fs.renameSync(filePath, archivedPath);
		} catch {
			/* authoritative import already committed */
		}
	}
}

function fingerprintCommittedScopeImportSource(
	directory: string,
): { authorityFiles: string[]; sourceDigest: string } | null {
	const scopesDir = getScopesDir(directory);
	try {
		fs.lstatSync(scopesDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	if (!isScopesDirSafe(directory, scopesDir)) return null;
	const names = fs.readdirSync(scopesDir).sort();
	if (names.length > bindingFileScanCapacity) return null;
	const authorityFiles: string[] = [];
	for (const name of names) {
		if (!name.startsWith('binding-') || !name.endsWith('.json')) continue;
		const filePath = path.join(scopesDir, name);
		authorityFiles.push(filePath);
		const intentPath = getRetirementIntentPath(filePath);
		if (fs.existsSync(intentPath)) authorityFiles.push(intentPath);
	}
	for (const name of names) {
		if (/^claim-[a-f0-9]{40}\.json$/i.test(name)) {
			authorityFiles.push(path.join(scopesDir, name));
		}
	}
	if (authorityFiles.length === 0) return null;
	const digest = createHash('sha256');
	for (const filePath of authorityFiles) {
		const raw = readBoundedFile(filePath);
		if (raw === null) return null;
		digest.update(path.basename(filePath));
		digest.update(raw);
	}
	return { authorityFiles, sourceDigest: digest.digest('hex') };
}

function collectLegacyScopeBindingsForImport(directory: string): {
	bindings: ScopeBinding[];
	authorityFiles: string[];
	sourceDigest: string;
	rowCount: number;
} {
	const scopesDir = getScopesDir(directory);
	try {
		fs.lstatSync(scopesDir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {
				bindings: [],
				authorityFiles: [],
				sourceDigest: 'empty',
				rowCount: 0,
			};
		}
		throw error;
	}
	if (!isScopesDirSafe(directory, scopesDir)) {
		throw new Error('The durable scope store failed containment checks.');
	}
	if (!migrateLegacyBindingsSync(directory)) {
		throw new Error(
			'The durable binding set could not be completely evaluated.',
		);
	}
	const names = fs.readdirSync(scopesDir).sort();
	if (names.length > bindingFileScanCapacity) {
		throw new Error('The durable binding set exceeds the scan capacity.');
	}
	const authorityFiles: string[] = [];
	const bindings: ScopeBinding[] = [];
	for (const name of names) {
		if (!name.startsWith('binding-') || !name.endsWith('.json')) continue;
		const filePath = path.join(scopesDir, name);
		authorityFiles.push(filePath);
		const raw = readBoundedFile(filePath);
		if (!raw) {
			throw new Error(`Legacy scope binding ${name} is unreadable.`);
		}
		const binding = validateScopeBindingPayload(
			directory,
			JSON.parse(raw) as Partial<ScopeBinding>,
		);
		if (!binding || !exactFilenameMatches(directory, filePath, binding)) {
			throw new Error(`Legacy scope binding ${name} is malformed.`);
		}
		const intentPath = getRetirementIntentPath(filePath);
		if (hasDurableRetirementIntent(filePath, binding)) {
			authorityFiles.push(intentPath);
			let createdAt = Date.now();
			const rawIntent = readBoundedFile(intentPath);
			if (!rawIntent) {
				throw new Error(
					`Legacy retirement intent ${path.basename(intentPath)} is unreadable.`,
				);
			}
			const parsedIntent = JSON.parse(rawIntent) as {
				bindingId?: unknown;
				generationId?: unknown;
				createdAt?: unknown;
			};
			if (
				parsedIntent.bindingId !== binding.bindingId ||
				parsedIntent.generationId !== binding.generationId
			) {
				throw new Error(
					`Legacy retirement intent ${path.basename(intentPath)} mismatches its generation.`,
				);
			}
			if (typeof parsedIntent.createdAt === 'number')
				createdAt = parsedIntent.createdAt;
			bindings.push({
				...binding,
				lifecycleState: 'revoked',
				updatedAt: createdAt,
				expiresAt: Math.min(binding.expiresAt, createdAt),
			});
			continue;
		}
		bindings.push(binding);
	}
	for (const name of names) {
		if (!/^claim-[a-f0-9]{40}\.json$/i.test(name)) continue;
		const filePath = path.join(scopesDir, name);
		authorityFiles.push(filePath);
		const raw = readBoundedFile(filePath);
		if (!raw) throw new Error(`Legacy claim receipt ${name} is unreadable.`);
		const parsed = JSON.parse(raw) as Partial<ScopeClaimReceipt>;
		if (
			parsed.version !== 1 ||
			!isScopeBindingIdentity(parsed.predecessorGenerationId) ||
			!isScopeBindingIdentity(parsed.winnerGenerationId) ||
			typeof parsed.childSessionId !== 'string' ||
			!parsed.childSessionId.trim() ||
			typeof parsed.dispatchCallId !== 'string' ||
			!parsed.dispatchCallId.trim()
		) {
			throw new Error(`Legacy claim receipt ${name} is malformed.`);
		}
		const winner = bindings.find(
			(binding) => binding.generationId === parsed.winnerGenerationId,
		);
		if (!winner) {
			throw new Error(`Legacy claim receipt ${name} has no winner generation.`);
		}
		if (
			winner.lifecycleState === 'live' &&
			winner.ownerSessionId !== parsed.childSessionId
		) {
			throw new Error(
				`Legacy claim receipt ${name} disagrees with the winner generation.`,
			);
		}
	}
	const digest = createHash('sha256');
	for (const filePath of authorityFiles) {
		if (!fs.existsSync(filePath)) continue;
		digest.update(path.basename(filePath));
		digest.update(fs.readFileSync(filePath));
	}
	return {
		bindings,
		authorityFiles,
		sourceDigest: digest.digest('hex'),
		rowCount: bindings.length,
	};
}

function ensureScopeBindingAuthorityImported(
	directory: string,
): ScopePersistenceResult<void> {
	try {
		const authorityExists =
			listCoordinationStates(directory, SCOPE_BINDING_COORDINATION_NAMESPACE, 1)
				.length > 0;
		if (authorityExists) {
			const importStatement = getProjectDb(directory).prepare(
				'SELECT source_digest FROM coordination_import WHERE source = ?',
			);
			let importRow: { source_digest: string } | undefined;
			try {
				importRow = importStatement.get(
					SCOPE_BINDING_COORDINATION_IMPORT_SOURCE,
				) as { source_digest: string } | undefined;
			} finally {
				importStatement.finalize();
			}
			const committedSource = fingerprintCommittedScopeImportSource(directory);
			// Once SQLite authority exists, arbitrary legacy/shadow artifacts cannot
			// participate in authorization. The sole exception is recovery of the exact
			// source generation committed by importCoordinationOnce before a crash.
			if (
				!importRow ||
				!committedSource ||
				importRow.source_digest !== committedSource.sourceDigest
			) {
				return { ok: true, value: undefined };
			}
		}
		const legacy = collectLegacyScopeBindingsForImport(directory);
		if (legacy.rowCount === 0 && legacy.authorityFiles.length === 0) {
			return { ok: true, value: undefined };
		}
		const denyLedgerForImport = readDenyLedger(directory);
		const deniedForImport =
			denyLedgerForImport.status === 'valid'
				? denyLedgerForImport.ledger.entries
				: null;
		// Issue #3889/v4c: a generation that carries a terminal deny-ledger
		// entry was retired. Never re-import it from a leftover binding file,
		// even if the durable namespace is empty (the AC5 backstop).
		const importedBindings = legacy.bindings
			.filter(
				(binding) =>
					deniedForImport?.[binding.generationId]?.kind !== 'terminal',
			)
			.map((binding) => ({ ...binding }));
		if (authorityExists) {
			archiveImportedScopeAuthorityFiles(legacy.authorityFiles);
			for (const binding of importedBindings) {
				writeScopeBindingShadow(directory, binding);
			}
			return { ok: true, value: undefined };
		}
		const outcome = importCoordinationOnce(
			directory,
			{
				source: SCOPE_BINDING_COORDINATION_IMPORT_SOURCE,
				sourceDigest: legacy.sourceDigest,
				rowCount: legacy.rowCount,
				emptyNamespace: SCOPE_BINDING_COORDINATION_NAMESPACE,
			},
			() => {
				importScopeBindingStateRows(directory, importedBindings);
			},
		);
		if (outcome === 'imported' || outcome === 'already_imported') {
			archiveImportedScopeAuthorityFiles(legacy.authorityFiles);
			for (const binding of importedBindings) {
				writeScopeBindingShadow(directory, binding);
			}
		}
		return { ok: true, value: undefined };
	} catch (error) {
		return persistenceFailure(
			`Scope binding import failed closed: ${
				error instanceof Error ? error.message : 'unknown import error'
			}`,
		);
	}
}

function readAllAuthoritativeScopeBindings(
	directory: string,
	options: { enforceLiveCapacity?: boolean; maintenanceScan?: boolean } = {},
): ScopePersistenceResult<ScopeBinding[]> {
	const imported = ensureScopeBindingAuthorityImported(directory);
	if (!imported.ok) return imported;
	try {
		const scanCapacity = options.maintenanceScan
			? maintenanceFileScanCapacity
			: bindingFileScanCapacity;
		const rows = listCoordinationStates(
			directory,
			SCOPE_BINDING_COORDINATION_NAMESPACE,
			scanCapacity + 1,
		);
		if (rows.length > scanCapacity) {
			return {
				ok: false,
				code: 'SCOPE_BINDING_STORE_OVERLOADED',
				message: 'The durable binding set exceeds the scan capacity.',
			};
		}
		const bindings = rows.map((row) =>
			parseCoordinationScopeBinding(directory, row),
		);
		if (bindings.some((binding) => binding === null)) {
			return persistenceFailure(
				'The authoritative scope binding set contains malformed coordination rows.',
			);
		}
		const complete = bindings as ScopeBinding[];
		// Issue #3889/v4c: a generation that carries a terminal deny-ledger
		// entry was retired. A live row re-imported for it (for example from a
		// leftover binding file after a failed shadow unlink) must not authorize
		// writes through ANY reader — resolver, child claim, pr-feedback, lease
		// refresh, parallel-verdict or epic readers all go through this function.
		// Applied here (the shared choke point) so no individual caller needs
		// its own copy. Maintenance scheduling still scans the full set (below);
		// the filter only drops retired generations from authorization views,
		// so the pruner never sees a row that is already retired.
		const denyLedgerForFilter = readDenyLedger(directory);
		const denyEntriesForFilter =
			denyLedgerForFilter.status === 'valid'
				? denyLedgerForFilter.ledger.entries
				: null;
		const authorized = denyEntriesForFilter
			? complete.filter(
					(binding) =>
						denyEntriesForFilter[binding.generationId]?.kind !== 'terminal',
				)
			: complete;
		const liveCount = authorized.filter(
			(binding) =>
				binding.lifecycleState === 'live' && binding.expiresAt > Date.now(),
		).length;
		if (
			options.enforceLiveCapacity !== false &&
			liveCount > liveBindingCapacity
		) {
			return {
				ok: false,
				code: 'SCOPE_BINDING_STORE_OVERLOADED',
				message: 'The durable binding set exceeds the live binding capacity.',
			};
		}
		// Issue #3889: schedule maintenance when the scanned set contains rows
		// collectable by the reworked pruner (decision from already-scanned
		// data; the per-directory job dedup bounds concurrency). The deny
		// ledger is consulted cheaply; an unreadable ledger schedules too (the
		// pruner then reports the corruption fail-closed).
		if (!options.maintenanceScan) {
			const denyRead = readDenyLedger(directory);
			const denyEntries =
				denyRead.status === 'valid' ? denyRead.ledger.entries : null;
			const now = Date.now();
			const hasCollectable =
				denyRead.status === 'unreadable' ||
				complete.some((binding) =>
					scopeRowCollectable(binding, denyEntries, now),
				);
			if (hasCollectable) scheduleScopeBindingMaintenance(directory);
		}
		return { ok: true, value: authorized };
	} catch (error) {
		return persistenceFailure(
			`Authoritative scope binding read failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

function deterministicIdentity(value: string): string {
	const hex = createHash('sha256').update(value).digest('hex').slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function validateScopeBindingPayload(
	directory: string,
	parsed: Partial<ScopeBinding>,
	options: { allowLegacy?: boolean } = {},
): ScopeBinding | null {
	const workspaceIdentity = canonicalWorkspaceIdentity(directory);
	const legacyWorkspaceIdentity =
		legacyCanonicalExistingFilesystemPath(directory);
	const files = Array.isArray(parsed.files)
		? normalizeScopeFiles(
				parsed.files.filter((file): file is string => typeof file === 'string'),
			)
		: null;
	if (
		parsed.version !== 2 ||
		!workspaceIdentity ||
		(parsed.workspaceIdentity !== workspaceIdentity &&
			parsed.workspaceIdentity !== legacyWorkspaceIdentity) ||
		!isSafeTaskId(parsed.taskId ?? '') ||
		!files ||
		typeof parsed.planId !== 'string' ||
		!parsed.planId ||
		typeof parsed.planStructureHash !== 'string' ||
		!parsed.planStructureHash ||
		typeof parsed.ownerSessionId !== 'string' ||
		!parsed.ownerSessionId.trim() ||
		typeof parsed.ownerMessageId !== 'string' ||
		!parsed.ownerMessageId.trim() ||
		!['declaration', 'pending_child', 'active'].includes(
			parsed.activation ?? '',
		) ||
		![
			'declare_scope',
			'plan',
			'file_directive',
			'pr_feedback',
			'worktree_derived',
		].includes(parsed.source ?? '') ||
		typeof parsed.declaredAt !== 'number' ||
		!Number.isFinite(parsed.declaredAt) ||
		typeof parsed.expiresAt !== 'number' ||
		!Number.isFinite(parsed.expiresAt)
	)
		return null;

	const legacySeed = JSON.stringify({
		workspaceIdentity,
		planId: parsed.planId,
		planStructureHash: parsed.planStructureHash,
		taskId: parsed.taskId,
		ownerSessionId: parsed.ownerSessionId,
		ownerMessageId: parsed.ownerMessageId,
		dispatchCallId: parsed.dispatchCallId,
		activation: parsed.activation,
		source: parsed.source,
		files,
		declaredAt: parsed.declaredAt,
	});
	const bindingId = isScopeBindingIdentity(parsed.bindingId)
		? parsed.bindingId
		: options.allowLegacy
			? deterministicIdentity(`binding\0${legacySeed}`)
			: null;
	const generationId = isScopeBindingIdentity(parsed.generationId)
		? parsed.generationId
		: options.allowLegacy
			? deterministicIdentity(`generation\0${legacySeed}`)
			: null;
	if (!bindingId || !generationId) return null;
	const lifecycleState =
		parsed.lifecycleState ?? (options.allowLegacy ? 'live' : undefined);
	if (
		!lifecycleState ||
		!['live', 'expired', 'revoked', 'superseded'].includes(lifecycleState)
	)
		return null;
	const revision = parsed.revision ?? (options.allowLegacy ? 1 : undefined);
	if (!Number.isSafeInteger(revision) || (revision ?? 0) < 1) return null;
	const updatedAt = parsed.updatedAt ?? parsed.declaredAt;
	const leaseStartedAt = parsed.leaseStartedAt ?? parsed.declaredAt;
	if (typeof updatedAt !== 'number' || typeof leaseStartedAt !== 'number')
		return null;
	const now = Date.now();
	if (
		parsed.declaredAt > now ||
		updatedAt < parsed.declaredAt ||
		leaseStartedAt < parsed.declaredAt ||
		(parsed.activation === 'declaration' &&
			parsed.dispatchCallId !== undefined) ||
		(parsed.activation === 'pending_child' &&
			(typeof parsed.dispatchCallId !== 'string' ||
				!parsed.dispatchCallId ||
				parsed.ownerMessageId !== parsed.dispatchCallId)) ||
		(parsed.activation === 'active' &&
			(typeof parsed.dispatchCallId !== 'string' ||
				!parsed.dispatchCallId ||
				parsed.ownerMessageId !== parsed.dispatchCallId ||
				typeof parsed.parentOwnerSessionId !== 'string' ||
				!parsed.parentOwnerSessionId ||
				parsed.ownerSessionId === parsed.parentOwnerSessionId ||
				parsed.parentCallId !== parsed.dispatchCallId))
	)
		return null;
	return {
		...(parsed as ScopeBinding),
		bindingId,
		generationId,
		revision: revision!,
		lifecycleState,
		files,
		workspaceIdentity,
		updatedAt,
		leaseStartedAt,
	};
}

function exactFilenameMatches(
	directory: string,
	filePath: string,
	binding: ScopeBinding,
): boolean {
	return (
		normalizePathForComparison(filePath) ===
		normalizePathForComparison(getBindingFilePath(directory, binding))
	);
}

/**
 * Deterministically upgrades weak v2 owner-hash filenames before any scan can
 * authorize them. A stale-aware lock gives independent runtimes one bounded
 * winner and recovers after a process crashes mid-migration.
 */
function migrateLegacyBindingsSync(
	directory: string,
	scanCapacity = bindingFileScanCapacity,
): boolean {
	try {
		assertProjectRoot(directory);
	} catch {
		return false;
	}
	const scopesDir = getScopesDir(directory);
	if (!isScopesDirSafe(directory, scopesDir)) return false;
	let names: string[];
	try {
		names = fs.readdirSync(scopesDir).sort();
	} catch {
		return true;
	}
	if (names.length > scanCapacity) return false;
	for (const name of names) {
		const match = /^binding-(.+)-([a-f0-9]{24})\.json$/i.exec(name);
		if (!match || !isSafeTaskId(match[1])) continue;
		const legacyPath = path.join(scopesDir, name);
		let releaseMigration: (() => void) | undefined;
		try {
			releaseMigration = lockfileWithSync.lockSync(legacyPath, {
				stale: LOCK_STALE_MS,
				realpath: false,
			});
		} catch {
			// Another runtime is reconciling this exact weak record. Authorize none
			// until the next complete scan observes its finished state.
			return false;
		}
		try {
			const raw = readBoundedFile(legacyPath);
			let binding: ScopeBinding | null = null;
			try {
				binding = raw
					? validateScopeBindingPayload(
							directory,
							JSON.parse(raw) as Partial<ScopeBinding>,
							{ allowLegacy: true },
						)
					: null;
			} catch {
				binding = null;
			}
			const ownerHash = binding
				? createHash('sha256')
						.update(binding.ownerSessionId)
						.digest('hex')
						.slice(0, 24)
				: '';
			const valid =
				binding &&
				binding.taskId === match[1] &&
				ownerHash.toLowerCase() === match[2].toLowerCase() &&
				normalizePathForComparison(
					getLegacyBindingFilePath(
						directory,
						binding.taskId,
						binding.ownerSessionId,
					),
				) === normalizePathForComparison(legacyPath);
			const archiveDir = path.join(scopesDir, 'archive');
			fs.mkdirSync(archiveDir, { recursive: true });
			const archiveStat = fs.lstatSync(archiveDir);
			if (!archiveStat.isDirectory() || archiveStat.isSymbolicLink())
				return false;
			const archiveDigest = createHash('sha256')
				.update(raw ?? name)
				.digest('hex')
				.slice(0, 32);
			if (valid && binding) {
				const exactPath = getBindingFilePath(directory, binding);
				if (!fs.existsSync(exactPath)) {
					// Canonical contained write (issue #2035) — supersedes the
					// bespoke `.migration-<pid>` temp which had no failure
					// cleanup; that grammar stays registered for residue
					// discovery.
					atomicWriteSwarmFileSync(exactPath, JSON.stringify(binding, null, 2));
				} else {
					const existingRaw = readBoundedFile(exactPath);
					const existing = existingRaw
						? validateScopeBindingPayload(
								directory,
								JSON.parse(existingRaw) as Partial<ScopeBinding>,
							)
						: null;
					if (
						!existing ||
						existing.bindingId !== binding.bindingId ||
						existing.generationId !== binding.generationId
					)
						return false;
				}
			}
			const archivePath = path.join(
				archiveDir,
				`${valid ? 'migrated' : 'quarantined'}-${archiveDigest}.json`,
			);
			if (!fs.existsSync(archivePath)) fs.renameSync(legacyPath, archivePath);
			else fs.unlinkSync(legacyPath);
			fs.writeFileSync(
				`${archivePath}.receipt.json`,
				JSON.stringify(
					{
						version: 1,
						legacyName: name,
						result: valid ? 'migrated' : 'quarantined',
						bindingId: binding?.bindingId,
						generationId: binding?.generationId,
					},
					null,
					2,
				),
			);
			const archiveEntries = fs.readdirSync(archiveDir).sort();
			for (const stale of archiveEntries.slice(
				0,
				Math.max(0, archiveEntries.length - 2 * MAX_DURABLE_TOMBSTONES),
			)) {
				const stalePath = path.join(archiveDir, stale);
				try {
					const stat = fs.lstatSync(stalePath);
					if (stat.isFile() && !stat.isSymbolicLink()) fs.unlinkSync(stalePath);
				} catch {
					/* concurrently pruned */
				}
			}
		} catch {
			return false;
		} finally {
			try {
				releaseMigration?.();
			} catch {
				/* stale/released */
			}
		}
	}
	return true;
}

/**
 * Write the legacy v1 `.swarm/scopes/scope-{taskId}.json` projection atomically.
 * Safe to call concurrently — proper-lockfile serialises writers per-file.
 *
 * Silent on I/O failure for backward compatibility. This projection is not an
 * authorization source; v2 callers use the fail-closed exact-generation APIs.
 */
export async function writeScopeToDisk(
	directory: string,
	taskId: string,
	files: string[],
	ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
	if (!isSafeTaskId(taskId)) return;
	if (!Array.isArray(files) || files.length === 0) return;
	if (files.length > MAX_FILES_PER_SCOPE) return; // DoS cap
	try {
		assertProjectRoot(directory);
	} catch {
		return;
	}

	const scopesDir = getScopesDir(directory);
	const scopePath = getScopeFilePath(directory, taskId);

	try {
		fs.mkdirSync(scopesDir, { recursive: true });
	} catch {
		return;
	}

	if (!isScopesDirSafe(directory, scopesDir)) return; // parent-dir symlink guard

	const now = Date.now();
	const payload: PersistedScope = {
		version: SCOPE_SCHEMA_VERSION,
		taskId,
		declaredAt: now,
		expiresAt: now + ttlMs,
		files: [...files],
	};
	const content = JSON.stringify(payload, null, 2);

	// proper-lockfile needs the file to exist before locking. Create with
	// O_NOFOLLOW so an attacker who wins the TOCTOU race cannot redirect the
	// initial zero-byte write through a symlink.
	try {
		const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT;
		const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		const fd = fs.openSync(scopePath, flags | nofollow);
		fs.closeSync(fd);
	} catch {
		return;
	}

	let release: (() => Promise<void>) | undefined;
	try {
		const lockPath = getGenerationLockPath(scopePath);
		if (!(await ensureLockTarget(lockPath))) return;
		release = await lockfile.lock(lockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
			realpath: false,
		});
		await atomicWrite(scopePath, content);
	} catch {
		// Silent — persistence failure must not crash declare_scope.
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock already released or stale */
			}
		}
	}
}

/**
 * Persist an identity-bound v2 authorization record. The v1 writer remains for
 * compatibility with older non-authorization consumers, but strict Task
 * preflight and declare_scope use only this schema.
 */
export async function writeScopeBindingToDisk(
	directory: string,
	binding: ScopeBinding,
): Promise<ScopePersistenceResult> {
	try {
		// Authoritative sink guard: no caller may bypass project-root validation
		// before this function creates or mutates the durable scope store.
		assertProjectRoot(directory);
	} catch (error) {
		return persistenceFailure(
			`Scope persistence project-root validation failed: ${error instanceof Error ? error.message : 'unknown validation error'}`,
		);
	}
	if (!isSafeTaskId(binding.taskId) || binding.version !== 2)
		return persistenceFailure('Invalid binding schema or task identity.');
	const workspaceIdentity = canonicalWorkspaceIdentity(directory);
	const files = normalizeScopeFiles(binding.files);
	if (
		!workspaceIdentity ||
		workspaceIdentity !== binding.workspaceIdentity ||
		!files ||
		!binding.ownerSessionId ||
		!binding.ownerMessageId ||
		!isScopeBindingIdentity(binding.bindingId) ||
		!isScopeBindingIdentity(binding.generationId) ||
		binding.revision < 1 ||
		(binding.lifecycleState === 'live' && binding.expiresAt <= Date.now())
	)
		return persistenceFailure(
			'Binding identity, workspace, scope, or lease is invalid.',
		);
	const imported = ensureScopeBindingAuthorityImported(directory);
	if (!imported.ok) return imported;
	const all = readAllAuthoritativeScopeBindings(directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) return all;
	const current = all.value.find(
		(candidate) => candidate.generationId === binding.generationId,
	);
	if (current && current.bindingId !== binding.bindingId) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message: 'The exact generation identity collides with another binding.',
		};
	}
	if (
		current &&
		current.revision === binding.revision &&
		current.lifecycleState === binding.lifecycleState &&
		JSON.stringify(current.files) === JSON.stringify(files)
	) {
		// Keep the compatibility shadow in sync even when the authoritative
		// generation is already at this revision.  This matters when a legacy
		// Windows identity (for example, an 8.3 `~1` path) was imported before
		// the host could resolve its physical path and a later read recovered the
		// canonical identity.  The SQLite row is already authoritative, but the
		// durable shadow must be re-keyed as well so future legacy readers do not
		// resurrect the stale identity.
		writeScopeBindingShadow(directory, current);
		return { ok: true, value: current };
	}
	const expectedRevision = current ? binding.revision - 1 : null;
	if (binding.revision !== (current?.revision ?? 0) + 1) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message: 'Exact generation write requires the next CAS revision.',
		};
	}
	const persisted = transitionScopeBindingState(
		directory,
		{ ...binding, files },
		expectedRevision,
	);
	if (persisted.ok) writeScopeBindingShadow(directory, persisted.value);
	return persisted;
}

function persistenceFailure(message: string): ScopePersistenceResult<never> {
	return { ok: false, code: 'SCOPE_BINDING_PERSISTENCE_FAILED', message };
}

/** Mandatory transaction: durable verification precedes memory authority. */
export async function persistAndRegisterScopeBinding(
	directory: string,
	binding: ScopeBinding,
): Promise<ScopePersistenceResult> {
	const persisted = await writeScopeBindingToDisk(directory, binding);
	if (!persisted.ok) return persisted;
	const admission = registerScopeBinding(persisted.value);
	if (admission.ok) {
		scheduleScopeBindingMaintenance(directory);
		return { ok: true, value: persisted.value };
	}
	const rollback = await tombstoneScopeBinding(
		directory,
		persisted.value,
		'superseded',
	);
	return {
		ok: false,
		code: rollback.ok ? admission.code : 'SCOPE_BINDING_PERSISTENCE_FAILED',
		message: rollback.ok
			? admission.message
			: `Memory admission failed and rollback failed: ${rollback.message}`,
	};
}

function rollbackAdmissionFailure(
	directory: string,
	persisted: ScopeBinding,
	admission: Extract<ScopeBindingAdmissionResult, { ok: false }>,
): ScopePersistenceResult<never> {
	// v4b item 3 (issues #3889/#3900): predecessors were retired through the
	// shared sink (deleted + deny-ledgered) and are NOT restored — a
	// re-declaration revokes the task's prior chain by definition. The
	// committed successor is retired through the same sink so a failed
	// admission can never leave an authorizable row. If this compensating
	// transaction itself fails, the admission-pending ledger entry written
	// with the successor's commit already denies it in every runtime.
	const now = Date.now();
	try {
		withCoordinationTransaction(directory, () => {
			const failure =
				_scopePersistenceInternals.retireScopeBindingGenerationWithinTransaction(
					directory,
					persisted,
					'revoked',
				);
			if (failure)
				throw new Error(failure.ok ? 'unreachable' : failure.message);
		});
	} catch (error) {
		return persistenceFailure(
			`Memory admission failed and durable rollback failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			} (the unadmitted generation stays deny-ledgered)`,
		);
	}
	const revokedCandidate: ScopeBinding = {
		...persisted,
		revision: persisted.revision + 1,
		lifecycleState: 'revoked',
		updatedAt: now,
		expiresAt: Math.min(persisted.expiresAt, now),
	};
	installScopeBindingTombstone(revokedCandidate);
	writeScopeBindingShadow(directory, revokedCandidate);
	return {
		ok: false,
		code: admission.code,
		message: admission.message,
	};
}

/** Read and fully validate a v2 binding; v1 records never authorize here. */
export function readScopeBindingFromDisk(input: {
	directory: string;
	taskId: string;
	plan: Plan;
	ownerSessionId: string;
	parentCallId?: string;
	requireDispatchCorrelation?: boolean;
	requireDeclaration?: boolean;
}): ScopeBinding | null {
	const resolved = resolveScopeBindingFromDisk({
		...input,
		includeExpired: false,
	});
	return resolved.status === 'found' ? resolved.binding : null;
}

/**
 * Resolve the currently-declared scope FILES for a task from the authoritative
 * v2 binding store (issue #2532 / PARALLEL-4).
 *
 * Scheduling/conflict consumers (the v8 parallel verdict, Rule-2 auto-commit)
 * must resolve task scopes from the same authority `declare_scope` writes —
 * never from the legacy v1 `scope-<taskId>.json` projection, which no
 * production code writes in the project root. This is a scheduling read, NOT
 * write authorization: it deliberately does not require owner-session or
 * dispatch correlation, but it DOES require an exact `planStructureHash`
 * match so a declaration made against an older plan revision cannot certify
 * disjointness for the current one.
 *
 * Fail-closed: zero live candidates (undeclared or store failure), live
 * candidates that DISAGREE on the file set, or an empty file list all return
 * `null`, which callers treat as "unknown scope" → serial. Multiple live
 * candidates that AGREE on the exact same file set are NOT ambiguous: the
 * delegation gate mints a dispatch-correlated binding (activation 'active',
 * child owner) alongside the architect's declaration binding for the same
 * task with the same files, and the scheduling question — "what is this
 * task's currently-declared scope?" — has one answer whenever they agree.
 *
 * `bindingSet` lets a multi-task caller hoist ONE
 * `readAllAuthoritativeScopeBindings` scan for the whole verdict (pass the
 * result of {@link readAuthoritativeScopeBindingSet}); omit it for a
 * single-task read.
 */
export function readDeclaredScopeFilesFromBindings(input: {
	directory: string;
	taskId: string;
	plan: Plan;
	bindingSet?: ScopeBinding[] | null;
}): string[] | null {
	if (!isSafeTaskId(input.taskId)) return null;
	const set: ScopeBinding[] | null =
		input.bindingSet !== undefined
			? input.bindingSet
			: readAuthoritativeScopeBindingSet(input.directory);
	if (set === null) return null;
	const planId = derivePlanId(input.plan);
	const structureHash = computePlanStructureHash(input.plan);
	const now = Date.now();
	const candidates = set.filter(
		(binding) =>
			binding.taskId === input.taskId &&
			binding.planId === planId &&
			binding.planStructureHash === structureHash &&
			binding.lifecycleState === 'live' &&
			binding.expiresAt > now,
	);
	if (candidates.length < 1) return null;
	const first = [...candidates[0].files].sort().join('\n');
	const agreeing = candidates.every(
		(candidate) => [...candidate.files].sort().join('\n') === first,
	);
	if (!agreeing) return null;
	const files = candidates[0].files;
	return Array.isArray(files) && files.length > 0 ? files : null;
}

/**
 * Hoisted single read of the authoritative v2 binding set for multi-task
 * scheduling consumers (issue #2532): one bounded scan shared by every
 * per-task {@link readDeclaredScopeFilesFromBindings} call in a verdict.
 * Returns `null` when the store is unreadable/overloaded so callers fail
 * closed to "unknown scope" per task.
 */
export function readAuthoritativeScopeBindingSet(
	directory: string,
): ScopeBinding[] | null {
	const set = readAllAuthoritativeScopeBindings(directory);
	return set.ok ? set.value : null;
}

export function resolveScopeBindingFromDisk(input: {
	directory: string;
	taskId: string;
	plan: Plan;
	ownerSessionId: string;
	parentCallId?: string;
	requireDispatchCorrelation?: boolean;
	requireDeclaration?: boolean;
	includeExpired?: boolean;
}): DurableScopeBindingResolution {
	if (!isSafeTaskId(input.taskId)) return { status: 'not_declared' };
	const completeSet = readAllAuthoritativeScopeBindings(input.directory);
	if (!completeSet.ok) {
		scheduleScopeBindingMaintenance(input.directory);
		// Issue #3889 RC1: only genuine capacity failures render as the
		// capacity class. Every other durable-read failure (malformed or
		// workspace-mismatched row, import error, thrown read) is its own
		// fail-closed class so the capacity remedy stops hiding real causes.
		if (completeSet.code !== 'SCOPE_BINDING_STORE_OVERLOADED') {
			return { status: 'store_unreadable' };
		}
		return { status: 'overloaded' };
	}
	// Tri-state deny-ledger read: an unreadable/corrupt ledger fails closed
	// BEFORE any candidate or in-memory fallback is trusted (plan v4 R3-1).
	const denyLedger = readDenyLedger(input.directory);
	if (denyLedger.status === 'unreadable') return { status: 'store_unreadable' };
	const denyEntries =
		denyLedger.status === 'valid' ? denyLedger.ledger.entries : null;
	const candidates = completeSet.value.filter(
		(parsed) =>
			parsed.taskId === input.taskId &&
			parsed.planId === derivePlanId(input.plan) &&
			parsed.planStructureHash === computePlanStructureHash(input.plan) &&
			parsed.ownerSessionId === input.ownerSessionId &&
			(input.requireDispatchCorrelation !== true ||
				isDispatchCorrelated(parsed)) &&
			(input.requireDeclaration !== true ||
				(parsed.activation === 'declaration' &&
					parsed.dispatchCallId === undefined)) &&
			(input.parentCallId === undefined ||
				parsed.parentCallId === input.parentCallId),
	);
	// Issue #3889/v4b: an unadmitted successor carries durable
	// admission-pending deny evidence (revision-ungated, per generationId)
	// — it must never resolve as an authorizable live candidate.
	// Issue #3889/v4c (final-critic r3): a generation that has a terminal
	// deny-ledger entry was retired; a live row re-imported for it (for
	// example from a leftover binding file) must not authorize writes.
	// Terminal entries outlive the durable row by design, so this check is
	// keyed on the ledger entry's existence, not on its revision.
	const live = candidates.filter(
		(candidate) =>
			candidate.lifecycleState === 'live' &&
			candidate.expiresAt > Date.now() &&
			denyEntries?.[candidate.generationId]?.kind !== 'admission-pending' &&
			denyEntries?.[candidate.generationId]?.kind !== 'terminal',
	);
	if (live.length > 1)
		return {
			status: 'ambiguous',
			candidates: live.slice(0, 8),
			totalCandidates: live.length,
		};
	if (live.length === 1) return { status: 'found', binding: live[0] };
	const expired = candidates.filter(
		(candidate) =>
			candidate.lifecycleState !== 'live' ||
			candidate.expiresAt <= Date.now() ||
			denyEntries?.[candidate.generationId]?.kind === 'admission-pending',
	);
	if (candidates.length > 0 && !input.includeExpired) {
		return { status: 'not_declared' };
	}
	return input.includeExpired && expired.length > 0
		? {
				status: 'expired',
				candidates: expired.slice(0, 8),
				totalCandidates: expired.length,
			}
		: (() => {
				// Preserve the synchronous same-process claim path only when the
				// authoritative set contains no matching generation at all. A foreign
				// durable revoke/supersede must outrank stale in-memory admission.
				const inMemory =
					input.requireDeclaration === true
						? []
						: getActiveScopeBindingsForSession({
								directory: input.directory,
								activeSessionId: input.ownerSessionId,
							}).filter(
								(binding) =>
									binding.taskId === input.taskId &&
									binding.planId === derivePlanId(input.plan) &&
									binding.planStructureHash ===
										computePlanStructureHash(input.plan) &&
									(input.requireDispatchCorrelation !== true ||
										isDispatchCorrelated(binding)) &&
									(input.parentCallId === undefined ||
										binding.parentCallId === input.parentCallId) &&
									// Terminal deny-ledger evidence outlives the durable
									// row: a stale in-memory copy of a retired generation
									// must NOT authorize writes (issue #3889, plan D2).
									!(denyEntries?.[binding.generationId]?.kind === 'terminal'),
							);
				if (inMemory.length > 1) {
					return {
						status: 'ambiguous' as const,
						candidates: inMemory.slice(0, 8),
						totalCandidates: inMemory.length,
					};
				}
				return inMemory.length === 1
					? ({ status: 'found', binding: inMemory[0] } as const)
					: ({ status: 'not_declared' } as const);
			})();
}

function isDispatchCorrelated(binding: ScopeBinding): boolean {
	return (
		binding.activation === 'active' &&
		typeof binding.dispatchCallId === 'string' &&
		binding.dispatchCallId.length > 0 &&
		binding.ownerMessageId === binding.dispatchCallId &&
		typeof binding.parentOwnerSessionId === 'string' &&
		binding.parentOwnerSessionId.length > 0 &&
		binding.ownerSessionId !== binding.parentOwnerSessionId &&
		binding.parentCallId === binding.dispatchCallId
	);
}

/** Remove one identity-bound authorization without disturbing sibling sessions. */
export function clearScopeBindingFromDisk(input: {
	directory: string;
	binding: ScopeBinding;
}): ScopePersistenceResult {
	// Deny this exact generation in memory before any filesystem validation or
	// retirement I/O. Session teardown must fail closed even when the workspace
	// can no longer be canonicalized (for example, an isolated lane root that
	// disappeared concurrently) or durable cleanup cannot acquire its lock.
	const localRetirement = installScopeBindingRetirementIntent(input.binding);
	try {
		assertProjectRoot(input.directory);
	} catch (error) {
		return persistenceFailure(
			`Scope retirement project-root validation failed: ${error instanceof Error ? error.message : 'unknown validation error'}`,
		);
	}
	const imported = ensureScopeBindingAuthorityImported(input.directory);
	if (!imported.ok) return imported;
	const all = readAllAuthoritativeScopeBindings(input.directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) return all;
	const current = all.value.find(
		(candidate) =>
			candidate.generationId === input.binding.generationId &&
			candidate.bindingId === input.binding.bindingId,
	);
	if (!current) {
		return localRetirement
			? { ok: true, value: localRetirement }
			: persistenceFailure(
					'Exact generation disappeared before serialized retirement.',
				);
	}
	if (current.lifecycleState !== 'live') {
		installScopeBindingTombstone(current);
		writeScopeBindingShadow(input.directory, current);
		return { ok: true, value: current };
	}
	const now = Date.now();
	const tombstone: ScopeBinding = {
		...current,
		revision: current.revision + 1,
		lifecycleState: 'revoked',
		updatedAt: now,
		expiresAt: Math.min(current.expiresAt, now),
	};
	// Shared sink (v4 item 5): session-teardown revocation deletes the row and
	// installs terminal deny evidence atomically, instead of leaving a
	// tombstone row for the age-based pruner.
	let sinkFailure: ScopePersistenceFailure | null = null;
	try {
		withCoordinationTransaction(input.directory, () => {
			const failure = retireScopeBindingGenerationWithinTransaction(
				input.directory,
				current,
				'revoked',
			);
			if (failure)
				throw new Error(failure.ok ? 'unreachable' : failure.message);
		});
	} catch (error) {
		sinkFailure = persistenceFailure(
			`Session teardown retirement failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		) as ScopePersistenceFailure;
	}
	if (sinkFailure) return sinkFailure;
	installScopeBindingTombstone(tombstone);
	removeScopeBindingShadow(input.directory, current);
	scheduleScopeBindingMaintenance(input.directory);
	return { ok: true, value: tombstone };
}

export async function tombstoneScopeBinding(
	directory: string,
	binding: ScopeBinding,
	reason: 'expired' | 'revoked' | 'superseded',
): Promise<ScopePersistenceResult> {
	const imported = ensureScopeBindingAuthorityImported(directory);
	if (!imported.ok) {
		installFailedRevocationOverlay(binding, reason);
		return imported;
	}
	const all = readAllAuthoritativeScopeBindings(directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) {
		installFailedRevocationOverlay(binding, reason);
		return all;
	}
	const current = all.value.find(
		(candidate) =>
			candidate.generationId === binding.generationId &&
			candidate.bindingId === binding.bindingId,
	);
	if (!current) {
		installFailedRevocationOverlay(binding, reason);
		return persistenceFailure('Exact generation disappeared before tombstone.');
	}
	if (current.revision !== binding.revision) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message: 'Tombstone CAS revision is stale.',
		};
	}
	if (current.lifecycleState !== 'live') return { ok: true, value: current };
	const now = Date.now();
	const tombstone: ScopeBinding = {
		...current,
		revision: current.revision + 1,
		lifecycleState: reason,
		updatedAt: now,
		expiresAt: Math.min(current.expiresAt, now),
	};
	// Shared sink: terminal transition deletes the row and installs durable
	// deny evidence atomically. The failed-revocation overlay below still
	// guards same-process admission when the sink cannot complete.
	let sinkFailure: ScopePersistenceFailure | null = null;
	try {
		withCoordinationTransaction(directory, () => {
			const failure = retireScopeBindingGenerationWithinTransaction(
				directory,
				current,
				reason,
			);
			if (failure)
				throw new Error(failure.ok ? 'unreachable' : failure.message);
		});
	} catch (error) {
		sinkFailure = persistenceFailure(
			`Scope tombstone sink failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		) as ScopePersistenceFailure;
	}
	if (sinkFailure) {
		installFailedRevocationOverlay(binding, reason);
		return sinkFailure;
	}
	clearExactScopeBinding(binding);
	installScopeBindingTombstone(tombstone);
	removeScopeBindingShadow(directory, current);
	scheduleScopeBindingMaintenance(directory);
	return { ok: true, value: tombstone };
}

async function ensureLockTarget(targetPath: string): Promise<boolean> {
	return ensureLockTargetSync(targetPath);
}

/** CAS renewal for one exact active generation. */
export async function refreshScopeBindingLease(input: {
	directory: string;
	bindingId: string;
	generationId: string;
	expectedRevision: number;
	activeSessionId: string;
	taskId: string;
	ttlMs?: number;
}): Promise<ScopePersistenceResult> {
	const imported = ensureScopeBindingAuthorityImported(input.directory);
	if (!imported.ok) return imported;
	const all = readAllAuthoritativeScopeBindings(input.directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) return all;
	const current = all.value.find(
		(candidate) =>
			candidate.bindingId === input.bindingId &&
			candidate.generationId === input.generationId &&
			candidate.taskId === input.taskId &&
			candidate.ownerSessionId === input.activeSessionId,
	);
	if (!current) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message:
				'Refresh identity is not the exact current session/task generation.',
		};
	}
	// v4c R5-1: lease renewal refuses while an admission-pending entry
	// covers the exact generation (revision bumping must not escape it).
	const renewalDeny = readDenyLedger(input.directory);
	if (
		renewalDeny.status === 'valid' &&
		renewalDeny.ledger.entries[input.generationId]?.kind === 'admission-pending'
	) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_STALE',
			message:
				'Refresh refused: the generation carries admission-pending deny evidence.',
		};
	}
	if (renewalDeny.status === 'unreadable') {
		return persistenceFailure(renewalDeny.reason);
	}
	if (
		current.lifecycleState !== 'live' ||
		current.expiresAt <= Date.now() ||
		current.revision !== input.expectedRevision
	) {
		return {
			ok: false,
			code:
				current.expiresAt <= Date.now()
					? 'SCOPE_BINDING_EXPIRED'
					: 'SCOPE_BINDING_STALE',
			message:
				'Refresh cannot renew an expired, tombstoned, or stale generation.',
		};
	}
	const now = Date.now();
	const refreshed: ScopeBinding = {
		...current,
		revision: current.revision + 1,
		updatedAt: now,
		leaseStartedAt: now,
		expiresAt: now + Math.max(1, input.ttlMs ?? DEFAULT_SCOPE_BINDING_TTL_MS),
	};
	const persisted = transitionScopeBindingState(
		input.directory,
		refreshed,
		current.revision,
	);
	if (!persisted.ok) return persisted;
	updateExactScopeBinding(persisted.value);
	writeScopeBindingShadow(input.directory, persisted.value);
	return persisted;
}

interface ScopeClaimReceipt {
	version: 1;
	predecessorGenerationId: string;
	winnerGenerationId: string;
	childSessionId: string;
	dispatchCallId: string;
	createdAt: number;
}

/**
 * Cross-process, successor-first claim transaction. All contenders for one
 * pending generation lock the same stable receipt path.
 *
 * #3403 (trust model): the claim correlates a live `pending_child` generation
 * on the (parentSessionId, dispatchCallId) pair — both host-typed (host session
 * id / Task part id). `childSessionId` is TOOL-EMITTED metadata on v1 hosts
 * (v2 synthesizes it from host progress, #3401), so whatever child id the
 * metadata names can become the claim winner. Outcomes, all typed:
 *   - no live pending generation for the pair → SCOPE_NOT_DECLARED (no scope
 *     binding claimed, no session identity mutated; the caller's #3036 lineage
 *     write is separate and is kept on this path);
 *   - an active successor already owned by the same child → ok (idempotent);
 *   - a different child already owns it → SCOPE_BINDING_ALREADY_CLAIMED;
 *   - more than one live generation matches → SCOPE_BINDING_AMBIGUOUS;
 *   - the generation has expired → SCOPE_BINDING_EXPIRED;
 *   - storage failures → SCOPE_BINDING_PERSISTENCE_FAILED / store-overload codes.
 * The caller (delegation-gate taskMetadata) stamps the winner's session
 * identity after a successful claim and rolls its lineage write back on every
 * other outcome, including a throw.
 */
export async function claimScopeBindingForChildDurably(input: {
	directory: string;
	parentSessionId: string;
	childSessionId: string;
	dispatchCallId: string;
}): Promise<
	ScopePersistenceResult<{ previous: ScopeBinding; claimed: ScopeBinding }>
> {
	if (
		!input.parentSessionId.trim() ||
		!input.childSessionId.trim() ||
		!input.dispatchCallId.trim() ||
		input.parentSessionId === input.childSessionId
	)
		return persistenceFailure(
			'Claim requires distinct non-empty parent/child identities and an exact dispatch call.',
		);
	const imported = ensureScopeBindingAuthorityImported(input.directory);
	if (!imported.ok) return imported;
	const initial = readAllAuthoritativeScopeBindings(input.directory, {
		enforceLiveCapacity: false,
	});
	if (!initial.ok) return initial;
	const pending = initial.value.filter(
		(binding) =>
			binding.lifecycleState === 'live' &&
			binding.expiresAt > Date.now() &&
			binding.activation === 'pending_child' &&
			binding.ownerSessionId === input.parentSessionId &&
			binding.dispatchCallId === input.dispatchCallId &&
			binding.ownerMessageId === input.dispatchCallId,
	);
	if (pending.length > 1) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_AMBIGUOUS',
			message: 'Multiple pending generations match this exact Task dispatch.',
		};
	}
	let predecessor = pending[0];
	if (!predecessor) {
		const successors = initial.value.filter(
			(binding) =>
				binding.lifecycleState === 'live' &&
				binding.expiresAt > Date.now() &&
				binding.activation === 'active' &&
				binding.parentOwnerSessionId === input.parentSessionId &&
				binding.dispatchCallId === input.dispatchCallId &&
				binding.predecessorGenerationId,
		);
		if (successors.length > 1) {
			return {
				ok: false,
				code: 'SCOPE_BINDING_AMBIGUOUS',
				message: 'Multiple active successors match this Task dispatch.',
			};
		}
		const existing = successors[0];
		if (existing?.ownerSessionId === input.childSessionId) {
			const admission = registerScopeBinding(existing);
			return admission.ok
				? { ok: true, value: { previous: existing, claimed: existing } }
				: {
						ok: false,
						code: admission.code,
						message: admission.message,
					};
		}
		return existing
			? {
					ok: false,
					code: 'SCOPE_BINDING_ALREADY_CLAIMED',
					message:
						'This Task dispatch was already claimed by a different child session.',
				}
			: initial.value.some(
						(candidate) =>
							candidate.ownerSessionId === input.parentSessionId &&
							candidate.dispatchCallId === input.dispatchCallId,
					)
				? {
						ok: false,
						code: 'SCOPE_BINDING_EXPIRED',
						message:
							'No live pending generation remains for this Task dispatch.',
					}
				: {
						ok: false,
						code: 'SCOPE_NOT_DECLARED',
						message: 'No pending generation matches this Task dispatch.',
					};
	}

	try {
		let claimed: ScopeBinding | null = null;
		let retired: ScopeBinding | null = null;
		let alreadyClaimed: ScopeBinding | null = null;
		withCoordinationTransaction(input.directory, () => {
			const currentSet = readAllAuthoritativeScopeBindings(input.directory, {
				enforceLiveCapacity: false,
			});
			if (!currentSet.ok) {
				throw new ScopeCoordinationAbort(currentSet);
			}
			const currentPredecessor = currentSet.value.find(
				(binding) =>
					binding.generationId === predecessor.generationId &&
					binding.bindingId === predecessor.bindingId,
			);
			const liveSuccessors = currentSet.value.filter(
				(binding) =>
					binding.predecessorGenerationId === predecessor.generationId &&
					binding.bindingId === predecessor.bindingId &&
					binding.lifecycleState === 'live' &&
					binding.expiresAt > Date.now(),
			);
			if (liveSuccessors.length > 1) {
				throw new ScopeCoordinationAbort({
					ok: false,
					code: 'SCOPE_BINDING_AMBIGUOUS',
					message:
						'Incompatible successors exist for one predecessor generation.',
				});
			}
			const existing = liveSuccessors[0];
			if (existing) {
				if (existing.ownerSessionId !== input.childSessionId) {
					throw new ScopeCoordinationAbort({
						ok: false,
						code: 'SCOPE_BINDING_ALREADY_CLAIMED',
						message:
							'This pending generation has a winner in another child session.',
					});
				}
				alreadyClaimed = existing;
				return;
			}
			if (
				!currentPredecessor ||
				currentPredecessor.lifecycleState !== 'live' ||
				currentPredecessor.expiresAt <= Date.now()
			) {
				throw new ScopeCoordinationAbort({
					ok: false,
					code: 'SCOPE_BINDING_EXPIRED',
					message: 'The pending predecessor expired before claim.',
				});
			}
			predecessor = currentPredecessor;
			const nextClaimed = createClaimedScopeBinding(predecessor, input);
			const claimedWrite =
				_scopePersistenceInternals.transitionScopeBindingStateWithinTransaction(
					input.directory,
					nextClaimed,
					null,
				);
			if (!claimedWrite.ok) {
				throw new ScopeCoordinationAbort(claimedWrite);
			}
			// v4b deny-first: the claimed successor is born with durable
			// admission-pending evidence in the SAME transaction.
			const pendingFailure = markAdmissionPendingWithinTransaction(
				input.directory,
				claimedWrite.value,
			);
			if (pendingFailure) throw new ScopeCoordinationAbort(pendingFailure);
			// Shared sink: predecessor row deleted + terminal deny-ledger entry
			// (immediate collection; deny evidence survives the deletion).
			const predecessorFailure = retireScopeBindingGenerationWithinTransaction(
				input.directory,
				predecessor,
				'superseded',
			);
			if (predecessorFailure)
				throw new ScopeCoordinationAbort(predecessorFailure);
			const superseded: ScopeBinding = {
				...predecessor,
				revision: predecessor.revision + 1,
				lifecycleState: 'superseded',
				updatedAt: claimedWrite.value.updatedAt,
				expiresAt: Math.min(
					predecessor.expiresAt,
					claimedWrite.value.updatedAt,
				),
			};
			claimed = claimedWrite.value;
			retired = superseded;
			removeScopeBindingShadow(input.directory, predecessor);
		});
		if (alreadyClaimed) {
			const alreadyClaimedBinding: ScopeBinding = alreadyClaimed;
			const admission = registerScopeBinding(alreadyClaimedBinding);
			if (admission.ok) {
				releaseAdmissionPending(
					input.directory,
					alreadyClaimedBinding.generationId,
					alreadyClaimedBinding.revision,
				);
			}
			return admission.ok
				? {
						ok: true,
						value: { previous: predecessor, claimed: alreadyClaimed },
					}
				: {
						ok: false,
						code: admission.code,
						message: admission.message,
					};
		}
		if (!predecessor || !claimed || !retired) {
			return persistenceFailure('Claim transaction did not settle a winner.');
		}
		const claimedBinding: ScopeBinding = claimed;
		const retiredBinding: ScopeBinding = retired;
		writeScopeBindingShadow(input.directory, claimedBinding);
		writeScopeBindingShadow(input.directory, retiredBinding);
		const admission = registerScopeBinding(claimedBinding);
		if (!admission.ok) {
			return rollbackAdmissionFailure(
				input.directory,
				claimedBinding,
				admission,
			);
		}
		releaseAdmissionPending(
			input.directory,
			claimedBinding.generationId,
			claimedBinding.revision,
		);
		installScopeBindingTombstone(retiredBinding);
		return {
			ok: true,
			value: { previous: predecessor, claimed: claimedBinding },
		};
	} catch (error) {
		if (error instanceof ScopeCoordinationAbort) return error.failure;
		return persistenceFailure(
			`Claim transaction failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

/**
 * Declaration transaction used by declare_scope. Replacement is restricted to
 * the same canonical workspace, task, and owning architect session.
 */
export async function replaceExistingScopeDeclaration(input: {
	directory: string;
	binding: ScopeBinding;
	replaceExisting: boolean;
}): Promise<ScopePersistenceResult> {
	try {
		assertProjectRoot(input.directory);
	} catch (error) {
		return persistenceFailure(
			`Scope declaration project-root validation failed: ${error instanceof Error ? error.message : 'unknown validation error'}`,
		);
	}
	const { binding } = input;
	if (
		binding.activation !== 'declaration' ||
		binding.dispatchCallId !== undefined
	)
		return persistenceFailure(
			'declare_scope may persist only a declaration generation.',
		);
	const imported = ensureScopeBindingAuthorityImported(input.directory);
	if (!imported.ok) return imported;
	const all = readAllAuthoritativeScopeBindings(input.directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) return all;
	const owned = all.value.filter(
		(candidate) =>
			candidate.lifecycleState === 'live' &&
			candidate.expiresAt > Date.now() &&
			candidate.workspaceIdentity === binding.workspaceIdentity &&
			candidate.taskId === binding.taskId &&
			candidate.ownerSessionId === binding.ownerSessionId &&
			candidate.generationId !== binding.generationId,
	);
	if (owned.length > 0 && !input.replaceExisting) {
		return {
			ok: false,
			code: 'SCOPE_BINDING_AMBIGUOUS',
			message:
				'A live owned generation already exists; retry declare_scope with replace_existing=true to revoke it atomically.',
		};
	}
	try {
		let persisted: ScopeBinding | null = null;
		const retired: ScopeBinding[] = [];
		withCoordinationTransaction(input.directory, () => {
			// D2b (v3): re-read the authoritative set INSIDE the transaction so a
			// child claimed between the pre-transaction read and this commit
			// cannot escape retirement.
			const inTx = readAllAuthoritativeScopeBindings(input.directory, {
				enforceLiveCapacity: false,
				maintenanceScan: true,
			});
			if (!inTx.ok) throw new ScopeCoordinationAbort(inTx);
			const chain = inTx.value.filter(
				(candidate) =>
					candidate.lifecycleState === 'live' &&
					candidate.workspaceIdentity === binding.workspaceIdentity &&
					candidate.taskId === binding.taskId &&
					candidate.generationId !== binding.generationId &&
					(candidate.ownerSessionId === binding.ownerSessionId ||
						candidate.parentOwnerSessionId === binding.ownerSessionId),
			);
			if (chain.length > 0 && !input.replaceExisting) {
				throw new ScopeCoordinationAbort({
					ok: false,
					code: 'SCOPE_BINDING_AMBIGUOUS',
					message:
						'A live owned generation already exists; retry declare_scope with replace_existing=true to revoke it atomically.',
				});
			}
			const create =
				_scopePersistenceInternals.transitionScopeBindingStateWithinTransaction(
					input.directory,
					binding,
					null,
				);
			if (!create.ok) {
				throw new ScopeCoordinationAbort(create);
			}
			persisted = create.value;
			// v4b deny-first: the committed successor is born with durable
			// admission-pending evidence in the SAME transaction, so a crash or
			// compensation failure can never leave it authorizable.
			const pendingFailure = markAdmissionPendingWithinTransaction(
				input.directory,
				create.value,
			);
			if (pendingFailure) throw new ScopeCoordinationAbort(pendingFailure);
			for (const prior of chain) {
				const retirement = retireScopeBindingGenerationWithinTransaction(
					input.directory,
					prior,
					'superseded',
				);
				if (retirement) throw new ScopeCoordinationAbort(retirement);
				const tombstone: ScopeBinding = {
					...prior,
					revision: prior.revision + 1,
					lifecycleState: 'superseded',
					updatedAt: create.value.updatedAt,
					expiresAt: Math.min(prior.expiresAt, create.value.updatedAt),
				};
				retired.push(tombstone);
			}
		});
		if (!persisted) {
			return persistenceFailure(
				'Declaration transaction did not persist a generation.',
			);
		}
		const persistedBinding: ScopeBinding = persisted;
		writeScopeBindingShadow(input.directory, persistedBinding);
		for (const prior of retired) {
			installScopeBindingTombstone(prior);
			removeScopeBindingShadow(input.directory, prior);
		}
		const admission = registerScopeBinding(persistedBinding);
		if (!admission.ok) {
			return rollbackAdmissionFailure(
				input.directory,
				persistedBinding,
				admission,
			);
		}
		// Admission succeeded: release the pending deny evidence (fail-closed
		// false-deny on release failure — a fresh declare recovers; v4b).
		releaseAdmissionPending(
			input.directory,
			persistedBinding.generationId,
			persistedBinding.revision,
		);
		scheduleScopeBindingMaintenance(input.directory);
		return { ok: true, value: persistedBinding };
	} catch (error) {
		if (error instanceof ScopeCoordinationAbort) return error.failure;
		return persistenceFailure(
			`Declaration transaction failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

const maintenanceContinuationPending = new Set<string>();

function scheduleScopeBindingMaintenance(directory: string): void {
	const key = canonicalExistingFilesystemPath(directory);
	if (key === null) return;
	if (maintenanceJobs.has(key)) return;
	while (maintenanceJobs.size >= MAX_MAINTENANCE_JOBS) {
		const oldest = maintenanceJobs.keys().next().value as string | undefined;
		if (!oldest) break;
		maintenanceJobs.delete(oldest);
	}
	const job = Promise.resolve()
		.then(() => pruneScopeBindingTombstones(directory))
		.then(() => undefined)
		.catch(() => undefined)
		.finally(() => {
			maintenanceJobs.delete(key);
			// #3889 (4.5 review finding 1): a full batch reschedules its own
			// continuation only AFTER leaving the dedup map — requesting it
			// inside the prune body is discarded while this job still holds
			// the key.
			if (maintenanceContinuationPending.has(key)) {
				maintenanceContinuationPending.delete(key);
				scheduleScopeBindingMaintenance(directory);
			}
		});
	maintenanceJobs.set(key, job);
}

export async function flushScopeBindingMaintenance(
	directory?: string,
): Promise<void> {
	const key = directory
		? canonicalExistingFilesystemPath(directory)
		: undefined;
	if (directory && key === null) return;
	// #3889 (4.5 round-2 finding 1): a drained batch may install a
	// continuation job in its finally; keep awaiting until the directory (or
	// the whole map) is quiet so ONE flush drains all batches. Bounded.
	const maxRounds =
		Math.ceil(maintenanceFileScanCapacity / MAX_MAINTENANCE_COLLECT_BATCH) + 2;
	for (let round = 0; round < maxRounds; round += 1) {
		const job = key ? maintenanceJobs.get(key) : undefined;
		const jobs = job ? [job] : key ? [] : [...maintenanceJobs.values()];
		if (jobs.length === 0) return;
		await Promise.all(jobs);
	}
}

/**
 * Maintenance-owned collection (issues #3889/#3900, plan v3/v4/v4d):
 *  - legacy terminal rows (pre-fix stores): deny-ledger backfill + delete;
 *  - time-expired live-state rows PAST the 24h revival window: terminal
 *    ledger entry + delete (also converts a pending entry for that row);
 *  - deny-ledger housekeeping (kind-aware prune; terminal FIFO cap);
 *  - settled claim receipts (unchanged).
 * Every collection is authority-first: the coordination delete is the CAS
 * exactness guard; shadow removal is best-effort secondary.
 */
const MAX_MAINTENANCE_COLLECT_BATCH = 128;

function scopeRowCollectable(
	binding: ScopeBinding,
	denyEntries: Record<string, ScopeDenyLedgerEntry> | null,
	now: number,
): boolean {
	if (binding.lifecycleState !== 'live') {
		// Legacy terminal row: collectible unless already deny-ledgered
		// (post-fix terminal rows are deleted at transition and never appear).
		return denyEntries?.[binding.generationId] === undefined;
	}
	// Live-state row past the revival window: revival is impossible, so the
	// row is collectible. Inside the window it stays (issue #2271 revival).
	return now - binding.expiresAt > SCOPE_BINDING_AUTO_REVIVE_WINDOW_MS;
}

async function collectScopeRowsThroughSink(
	directory: string,
	rows: readonly ScopeBinding[],
): Promise<number> {
	let collected = 0;
	for (const row of rows) {
		try {
			withCoordinationTransaction(directory, () => {
				const failure = retireScopeBindingGenerationWithinTransaction(
					directory,
					row,
					row.lifecycleState === 'live' ? 'expired' : 'superseded',
				);
				if (failure)
					throw new Error(failure.ok ? 'unreachable' : failure.message);
			});
			collected += 1;
			removeScopeBindingShadow(directory, row);
		} catch {
			/* row changed concurrently or delete raced; leave for the next run */
		}
	}
	return collected;
}

/** Prune old non-authorizing generations and settled receipts under one lock. */
export async function pruneScopeBindingTombstones(
	directory: string,
): Promise<ScopePersistenceResult<number>> {
	const lockPath = path.join(
		getScopesDir(directory),
		'maintenance.lock-target',
	);
	if (!(await ensureLockTarget(lockPath)))
		return persistenceFailure('Could not prepare scope maintenance lock.');
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
			realpath: false,
		});
		const readAll = readAllAuthoritativeScopeBindings(directory, {
			enforceLiveCapacity: false,
			maintenanceScan: true,
		});
		if (!readAll.ok) return readAll;
		const all = readAll.value;
		const denyRead = readDenyLedger(directory);
		// Fail closed: while the deny ledger is unreadable, collect nothing —
		// deleting rows without their deny evidence would fail open.
		if (denyRead.status === 'unreadable')
			return persistenceFailure(denyRead.reason);
		const denyEntries =
			denyRead.status === 'valid' ? denyRead.ledger.entries : null;
		const now = Date.now();
		const collectable = all
			.filter((binding) => scopeRowCollectable(binding, denyEntries, now))
			.slice(0, MAX_MAINTENANCE_COLLECT_BATCH);
		let collected = await collectScopeRowsThroughSink(directory, collectable);
		// Ledger housekeeping pass (prunes terminal entries past TTL, applies
		// the terminal FIFO cap; pending entries are never evicted here).
		try {
			withCoordinationTransaction(directory, () => {
				const failure = writeDenyLedgerWithinTransaction(directory, () => {});
				if (failure && !failure.ok) throw new Error(failure.message);
			});
		} catch {
			/* ledger housekeeping is retried on the next maintenance run */
		}
		// Settled claim receipts (unchanged behavior).
		let receiptNames: string[] = [];
		try {
			receiptNames = fs
				.readdirSync(getScopesDir(directory))
				.filter((name) => /^claim-[a-f0-9]{40}\.json$/i.test(name))
				.slice(0, MAX_BINDING_FILES_TO_SCAN);
		} catch {
			/* store disappeared */
		}
		for (const name of receiptNames) {
			const receiptPath = path.join(getScopesDir(directory), name);
			let releaseReceipt: (() => Promise<void>) | undefined;
			try {
				releaseReceipt = await lockfile.lock(receiptPath, {
					stale: LOCK_STALE_MS,
					retries: { retries: 0 },
					realpath: false,
				});
				const raw = readBoundedFile(receiptPath);
				if (!raw) continue;
				const stale =
					Date.now() - fs.statSync(receiptPath).mtimeMs > MAX_TOMBSTONE_AGE_MS;
				let winnerKnown = false;
				try {
					const receipt = JSON.parse(raw) as ScopeClaimReceipt;
					winnerKnown = all.some(
						(binding) =>
							binding.bindingId === receipt.winnerGenerationId ||
							binding.generationId === receipt.winnerGenerationId,
					);
				} catch {
					/* malformed receipts are removable once old */
				}
				if (stale && !winnerKnown) {
					fs.unlinkSync(receiptPath);
					collected += 1;
				}
			} catch {
				/* receipt raced with a claim */
			} finally {
				if (releaseReceipt)
					try {
						await releaseReceipt();
					} catch {
						/* stale/released */
					}
			}
		}
		// Reschedule when more collectable rows remain AND this round made
		// progress (bounded drain, zero-progress guard). The continuation is
		// consumed by the job wrapper's finally (see
		// scheduleScopeBindingMaintenance) so it survives the dedup map; gating
		// on `collected > 0` stops a persistently faulted sink (every delete
		// failing while reads still work) from re-arming a zero-progress loop
		// — the next read/write trigger retries instead.
		const remaining = all.length - collectable.length;
		if (
			collected > 0 &&
			collectable.length === MAX_MAINTENANCE_COLLECT_BATCH &&
			remaining > 0
		) {
			maintenanceContinuationPending.add(
				canonicalExistingFilesystemPath(directory) ?? directory,
			);
		}
		return { ok: true, value: collected };
	} catch (error) {
		return persistenceFailure(
			`Scope maintenance failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	} finally {
		if (release)
			try {
				await release();
			} catch {
				/* stale/released */
			}
	}
}

function readCurrentPlan(directory: string): Plan | null {
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const stat = fs.statSync(planPath);
		if (!stat.isFile() || stat.size > MAX_PLAN_BYTES) return null;
		const parsed = PlanSchema.safeParse(
			JSON.parse(fs.readFileSync(planPath, 'utf8')),
		);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

/**
 * Issue #2271 bug 5: how long an expired-but-never-consumed live generation
 * may sit idle and still be auto-revived at the authorization gate. Matches
 * the legacy v1 scope TTL (24 h). Bindings idle longer than this, and any
 * binding that was deliberately tombstoned, revoked, superseded, or covered
 * by a deny overlay, keep the fail-closed SCOPE_BINDING_EXPIRED behavior.
 */
const SCOPE_BINDING_AUTO_REVIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Issue #2271 bug 5: record an idle-binding revival in the session ledger so
 * a re-extended write authorization is auditable. Best-effort — a ledger
 * write failure must never fail the revival itself.
 */
function appendScopeBindingRevivalEvent(
	workspace: string,
	revived: ScopeBinding,
): void {
	try {
		appendCoreEventSync(workspace, {
			type: 'scope_binding_auto_recovered',
			timestamp: new Date().toISOString(),
			taskId: revived.taskId,
			sessionId: revived.ownerSessionId,
			generationId: revived.generationId,
			revision: revived.revision,
			expiresAt: new Date(revived.expiresAt).toISOString(),
		});
	} catch {
		/* best-effort audit trail */
	}
}

/**
 * Issue #2271 bug 5: transparently revive a scope binding that expired while
 * the owning session was idle (user interaction, config edits, commits) so a
 * dispatch does not waste an attempt on SCOPE_BINDING_EXPIRED.
 *
 * Revival is a serialized CAS on the durable generation file: only the single
 * unambiguous candidate, still `live` in its durable payload (a tombstoned or
 * revoked file is a deliberate denial, never revived), inside the bounded
 * idle window, with no deny overlay, and only when the on-disk generation has
 * not changed since the read. Sweep-signature in-memory tombstones
 * ('expired' lifecycle at revision+1, which would otherwise outrank the
 * revived revision) are explicitly cleared after the verified write via
 * clearSweepTombstoneForRevival; deliberate revocation-class overlays
 * ('revoked'/'superseded') are neither ignored nor cleared, and the durable
 * CAS re-read refuses any on-disk tombstone, so a deliberate later
 * revocation always wins.
 *
 * Returns the revived binding, or null when revival is not permitted (the
 * caller then keeps the original expired resolution — fail closed).
 */
function attemptIdleScopeBindingRevival(
	directory: string,
	resolution: DurableScopeBindingResolution,
): ScopeBinding | null {
	if (resolution.status !== 'expired') return null;
	// Multiple expired candidates are ambiguous — never guess which to revive.
	if (resolution.totalCandidates !== 1 || resolution.candidates.length !== 1)
		return null;
	const candidate = resolution.candidates[0];
	if (!candidate) return null;
	const now = Date.now();
	if (candidate.lifecycleState !== 'live') return null;
	if (candidate.expiresAt > now) return null;
	if (now - candidate.expiresAt > SCOPE_BINDING_AUTO_REVIVE_WINDOW_MS)
		return null;
	// v4c R5-1: an admission-pending ledger entry denies by generationId,
	// revision-ungated — revival must refuse while one covers the generation.
	const revivalDeny = readDenyLedger(directory);
	if (
		revivalDeny.status === 'valid' &&
		revivalDeny.ledger.entries[candidate.generationId]?.kind ===
			'admission-pending'
	)
		return null;
	if (revivalDeny.status === 'unreadable') return null;
	// Sweep-signature tombstones ('expired' lifecycle from in-memory
	// sweepExpired on any scope read) do not block revival — the durable CAS
	// below re-verifies the on-disk generation. Deliberate revocation classes
	// still fail closed here.
	if (hasDeliberateScopeBindingDenyOverlay(candidate)) return null;
	const imported = ensureScopeBindingAuthorityImported(directory);
	if (!imported.ok) return null;
	const all = readAllAuthoritativeScopeBindings(directory, {
		enforceLiveCapacity: false,
	});
	if (!all.ok) return null;
	const current = all.value.find(
		(binding) =>
			binding.bindingId === candidate.bindingId &&
			binding.generationId === candidate.generationId,
	);
	if (
		!current ||
		current.revision !== candidate.revision ||
		current.lifecycleState !== 'live' ||
		current.expiresAt > Date.now() ||
		Date.now() - current.expiresAt > SCOPE_BINDING_AUTO_REVIVE_WINDOW_MS
	) {
		return null;
	}
	const revivedAt = Date.now();
	const revived: ScopeBinding = {
		...current,
		revision: current.revision + 1,
		updatedAt: revivedAt,
		leaseStartedAt: revivedAt,
		expiresAt: revivedAt + DEFAULT_SCOPE_BINDING_TTL_MS,
	};
	const persisted = transitionScopeBindingState(
		directory,
		revived,
		current.revision,
	);
	if (!persisted.ok) return null;
	writeScopeBindingShadow(directory, persisted.value);
	// A sweep-signature in-memory tombstone (revision+1, 'expired') would
	// otherwise deny the revived generation at the next resolution — its
	// revision equals this revival's. Deliberate overlays are untouched.
	clearSweepTombstoneForRevival(persisted.value);
	appendScopeBindingRevivalEvent(directory, persisted.value);
	return persisted.value;
}

function resolveAuthorizedScopeBindingForPlan(input: {
	directory: string;
	plan: Plan;
	taskId: string;
	activeSessionId: string;
}): ScopeBinding | null {
	const resolution = resolveAuthorizedScopeBindingForPlanDetailed(input);
	return resolution.status === 'found' ? resolution.binding : null;
}

function resolveAuthorizedScopeBindingForPlanDetailed(input: {
	directory: string;
	plan: Plan;
	taskId: string;
	activeSessionId: string;
}): DurableScopeBindingResolution {
	const durable = resolveScopeBindingFromDisk({
		directory: input.directory,
		taskId: input.taskId,
		plan: input.plan,
		ownerSessionId: input.activeSessionId,
		requireDispatchCorrelation: true,
		includeExpired: true,
	});
	if (durable.status === 'found') {
		if (hasScopeBindingDenyOverlay(durable.binding))
			return {
				status: 'expired',
				candidates: [durable.binding],
				totalCandidates: 1,
			};
		const admission = registerScopeBinding(durable.binding);
		if (admission.ok) return durable;
		// Issue #3889 RC1 (in-memory collapse): classify the admission failure
		// truthfully — only map saturation is a capacity condition.
		if (admission.code === 'SCOPE_BINDING_CAPACITY')
			return { status: 'overloaded' };
		return {
			status: 'expired',
			candidates: [durable.binding],
			totalCandidates: 1,
		};
	}
	// Issue #2271 bug 5: a single binding that merely expired while the owning
	// session was idle is auto-revived here (serialized CAS, bounded window,
	// deny overlays and deliberate tombstones still fail closed) instead of
	// burning the dispatch attempt on SCOPE_BINDING_EXPIRED.
	if (durable.status === 'expired') {
		const revived = attemptIdleScopeBindingRevival(input.directory, durable);
		if (revived) {
			const admission = registerScopeBinding(revived);
			if (admission.ok) return { status: 'found', binding: revived };
		}
	}
	if (durable.status !== 'not_declared') return durable;
	return { status: 'not_declared' };
}

export function resolveAuthorizedScopeBinding(input: {
	directory: string;
	taskId: string;
	activeSessionId: string;
}): ScopeBinding | null {
	const plan = readCurrentPlan(input.directory);
	return plan ? resolveAuthorizedScopeBindingForPlan({ ...input, plan }) : null;
}

export function resolveAuthorizedScopeBindingDetailed(input: {
	directory: string;
	taskId: string;
	activeSessionId: string;
}): DurableScopeBindingResolution {
	const plan = readCurrentPlan(input.directory);
	return plan
		? resolveAuthorizedScopeBindingForPlanDetailed({ ...input, plan })
		: { status: 'not_declared' };
}

/**
 * Recover one unambiguous child binding after an in-memory session restart.
 * Every candidate is still checked against current plan identity, exact child
 * session ownership, Task-call correlation, TTL, and active state.
 */
export function resolveAuthorizedScopeBindingForSession(input: {
	directory: string;
	activeSessionId: string;
}): ScopeBinding | null {
	const resolution = resolveAuthorizedScopeBindingForSessionDetailed(input);
	return resolution.status === 'found' ? resolution.binding : null;
}

export function resolveAuthorizedScopeBindingForSessionDetailed(input: {
	directory: string;
	activeSessionId: string;
}): DurableScopeBindingResolution {
	const plan = readCurrentPlan(input.directory);
	if (!plan) return { status: 'not_declared' };
	const matches: ScopeBinding[] = [];
	const expired: ScopeBinding[] = [];
	let expiredTotal = 0;
	for (const task of plan.phases.flatMap((phase) => phase.tasks)) {
		const resolution = resolveAuthorizedScopeBindingForPlanDetailed({
			directory: input.directory,
			plan,
			taskId: task.id,
			activeSessionId: input.activeSessionId,
		});
		if (resolution.status === 'overloaded') return resolution;
		if (resolution.status === 'store_unreadable') return resolution;
		if (resolution.status === 'ambiguous') return resolution;
		if (resolution.status === 'found') matches.push(resolution.binding);
		if (resolution.status === 'expired') {
			expired.push(...resolution.candidates);
			expiredTotal += resolution.totalCandidates;
		}
		if (matches.length > 1)
			return {
				status: 'ambiguous',
				candidates: matches.slice(0, 8),
				totalCandidates: matches.length,
			};
	}
	if (matches[0]) return { status: 'found', binding: matches[0] };
	return expired.length > 0
		? {
				status: 'expired',
				candidates: expired.slice(0, 8),
				totalCandidates: expiredTotal,
			}
		: { status: 'not_declared' };
}

/** Recover one exact planless PR_FEEDBACK child binding after plugin restart. */
export function resolveAuthorizedPrFeedbackScopeBindingFromDisk(input: {
	directory: string;
	activeSessionId: string;
	taskId?: string;
}): ScopeBinding | null {
	if (!input.activeSessionId.trim()) return null;
	const authoritative = readAllAuthoritativeScopeBindings(input.directory, {
		enforceLiveCapacity: false,
	});
	if (!authoritative.ok) return null;
	const now = Date.now();
	const matches = authoritative.value.filter(
		(parsed) =>
			parsed.source === 'pr_feedback' &&
			(!input.taskId || parsed.taskId === input.taskId) &&
			parsed.ownerSessionId === input.activeSessionId &&
			parsed.activation === 'active' &&
			typeof parsed.dispatchCallId === 'string' &&
			parsed.dispatchCallId.length > 0 &&
			parsed.ownerMessageId === parsed.dispatchCallId &&
			typeof parsed.parentOwnerSessionId === 'string' &&
			parsed.parentOwnerSessionId.length > 0 &&
			parsed.ownerSessionId !== parsed.parentOwnerSessionId &&
			parsed.parentCallId === parsed.dispatchCallId &&
			parsed.workflowSessionId === parsed.parentOwnerSessionId &&
			typeof parsed.workflowRevisionDigest === 'string' &&
			parsed.workflowRevisionDigest.length > 0 &&
			parsed.planId === `pr-feedback:${parsed.workflowSessionId}` &&
			parsed.planStructureHash === parsed.workflowRevisionDigest &&
			parsed.declaredAt <= now &&
			parsed.expiresAt > now &&
			parsed.lifecycleState === 'live' &&
			!hasScopeBindingDenyOverlay(parsed),
	);
	if (matches.length !== 1) return null;
	const admission = registerScopeBinding(matches[0]);
	return admission.ok ? matches[0] : null;
}

/**
 * Atomic write via temp + rename, delegated to the canonical helper
 * (`src/utils/atomic-write.ts`, issue #2035): `.swarm` containment, the
 * registered `canonical-v1` temp grammar, fsync, bounded rename retry, and
 * exact own-temp cleanup. The temp-file grammar this module produced before
 * (`target.tmp.<ts>.<rand>`) stays registered in `SWARM_TEMP_GRAMMARS` so
 * historical residue remains discoverable.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
	await atomicWriteSwarmFile(targetPath, content);
}

function atomicWriteSync(targetPath: string, content: string): void {
	atomicWriteSwarmFileSync(targetPath, content);
}

/** Hard bound on reset-sweep passes (defense in depth: every pass that
 * continues removed at least one row, so the loop is already bound by the
 * store size — a mis-set scan capacity must never spin the command). */
const MAX_RESET_SWEEP_PASSES = 32;

export interface ScopeResetSweepOutcome {
	/** Distinct rows of the reset sessions that the sweep left cleared: its
	 * latest word on each is a retirement it confirmed. A row that another
	 * process re-inserts, where the sweep then cannot confirm a retirement or
	 * sees it corrupt, is reported in that other bucket instead. */
	removed: number;
	/** Rows the sweep last saw with a payload no session can claim
	 * (unparseable, or an object carrying no session id). Never removed on a
	 * guess, and not read again: they are reported as seen, not as certainly
	 * still present. A row that a later page can attribute again, or retires,
	 * is not counted. */
	unidentifiable: number;
	/** The store could not be enumerated: nothing was swept past the point
	 * the read failed. */
	unreadable: boolean;
	/** The sweep stopped before it could confirm the store was seen in full
	 * — a full page removed nothing, or the pass limit was reached: rows of
	 * the reset sessions may remain unswept. */
	truncated: boolean;
	/** Rows whose last retirement attempt by this sweep threw — so the sweep
	 * has no confirmation, whichever the transaction did — and that were read
	 * again and found still present and still the reset sessions'. */
	failed: number;
	/** Rows whose last retirement attempt by this sweep threw and that the
	 * store then refused to read again: whether they remain is not known. */
	unchecked: number;
	/** Rows whose last retirement attempt by this sweep threw and that the
	 * sweep then found gone, or no longer the reset sessions'. Every attempt
	 * whose outcome is unknown ends in exactly one report: here, `unchecked`,
	 * `failed` or `unidentifiable`. Whether the sweep's own transaction
	 * committed is not known, so these rows are not counted as cleared. */
	unconfirmedRelinquished: number;
}

/**
 * Reset-session scope sweep (issue #3889 AC5, plan D3): raw-authoritative
 * enumeration — rows are attributed by RAW payload fields (owner, parent, or
 * workflow session) without full validation — and removed through the shared
 * transactional sink, so another runtime stale in-memory copy stays denied
 * after the durable row disappears. Unidentifiable rows (unparseable
 * payloads) are left in place and counted for an operator-cleanup warning.
 * In-memory bindings for the same lineage are cleared on every exit path so
 * the reset cannot resurrect authority through the memory fallback.
 *
 * Reporting states only what the sweep established. A store that cannot be
 * enumerated is reported `unreadable` — never as a silent zero — and the
 * sweep pages while rows are being removed, reporting `truncated` when it
 * stops before it could confirm the store was seen in full (a full page
 * removed nothing, or the pass limit was reached). A row is reported ONE
 * way: the sweep's latest word on each key decides its single bucket. A key
 * is cleared only while that latest word is a retirement the sweep
 * confirmed; a later observation replaces it — the row was last seen
 * unidentifiable, or its last retirement attempt threw. A throw does not say
 * whether the retirement committed — the transaction wrapper restores a
 * pragma after COMMIT and lets that error propagate — and no such attempt is
 * dropped silently: it ends in exactly one report. A row is read again
 * unless a later listing already showed the key as someone else's. Read
 * again, it is still the reset sessions' (`failed`), found corrupt
 * (`unidentifiable`), refused by the store (`unchecked`), or gone or no
 * longer theirs (`unconfirmedRelinquished`); a later listing as someone
 * else's is `unconfirmedRelinquished` too.
 */
export async function clearSessionScopeBindingsFromDisk(
	directory: string,
	sessionIds: readonly string[],
): Promise<ScopeResetSweepOutcome> {
	const wanted = new Set(sessionIds);
	const outcome: ScopeResetSweepOutcome = {
		removed: 0,
		unidentifiable: 0,
		unreadable: false,
		truncated: false,
		failed: 0,
		unchecked: 0,
		unconfirmedRelinquished: 0,
	};
	// The sweep's latest word on a row it has not left cleared, in two places
	// that never name the same key — so a row is never reported two ways:
	//   pending 'unidentifiable' — last seen with a payload no session can
	//                             claim;
	//   pending 'unconfirmed'    — its last retirement attempt threw. That does
	//                             not say whether the retirement committed
	//                             (the transaction wrapper restores a pragma
	//                             after COMMIT and lets that error propagate).
	//                             It stays unresolved until the final read —
	//                             unless a later listing shows the key as
	//                             someone else's.
	//   relinquishedKeys        — an attempt threw and the row is then known to
	//                             be gone or no longer the reset sessions'.
	// So a key reaches the final read only when the sweep's LAST listing of it
	// was the reset sessions'.
	const pending = new Map<string, 'unidentifiable' | 'unconfirmed'>();
	const relinquishedKeys = new Set<string>();
	// Keys the sweep left cleared. By key: a row that another process
	// re-inserts and a later page retires again is one cleared row, not two.
	const removedKeys = new Set<string>();
	/** Record the sweep's latest word on a row (`null`: nothing unresolved).
	 * It replaces every earlier word — an earlier cleared status, or an
	 * earlier "gone or no longer theirs" — so a row that another process
	 * re-inserts and the sweep sees again is reported one way. */
	const classify = (
		generationId: string,
		mark: 'unidentifiable' | 'unconfirmed' | null,
	): void => {
		if (mark === null) pending.delete(generationId);
		else pending.set(generationId, mark);
		removedKeys.delete(generationId);
		relinquishedKeys.delete(generationId);
	};
	/** Raw attribution of one row payload to the reset sessions. */
	const attributionOf = (
		payload: string,
	): {
		kind: 'unparseable' | 'unattributable' | 'other' | 'wanted';
		parsed: Record<string, unknown> | null;
	} => {
		let candidate: unknown;
		try {
			candidate = JSON.parse(payload);
		} catch {
			return { kind: 'unparseable', parsed: null };
		}
		// A payload that parses but is not an object (null, numbers, strings,
		// booleans, arrays) cannot be attributed either.
		if (
			candidate === null ||
			typeof candidate !== 'object' ||
			Array.isArray(candidate)
		)
			return { kind: 'unattributable', parsed: null };
		const parsed = candidate as Record<string, unknown>;
		const text = (key: string): string | null =>
			typeof parsed[key] === 'string' ? (parsed[key] as string) : null;
		const ids = [
			text('ownerSessionId'),
			text('parentOwnerSessionId'),
			text('workflowSessionId'),
		].filter(
			(value): value is string => value !== null && value.trim().length > 0,
		);
		// No session can claim the row. Every well-formed binding carries a
		// non-empty owner, so this is a malformed (or foreign-schema) row —
		// the realistic corruption that renders the store unreadable. A blank
		// session id never claims a row, on either side of the comparison.
		if (ids.length === 0) return { kind: 'unattributable', parsed };
		return {
			kind: ids.some((value) => wanted.has(value)) ? 'wanted' : 'other',
			parsed,
		};
	};
	// In-memory authority for the same lineage must not survive the reset —
	// on every exit path, whatever the durable sweep could read.
	const clearLineage = (): void => {
		clearScopeBindings(
			(binding) =>
				wanted.has(binding.ownerSessionId) ||
				(binding.parentOwnerSessionId !== undefined &&
					wanted.has(binding.parentOwnerSessionId)) ||
				(binding.workflowSessionId !== undefined &&
					wanted.has(binding.workflowSessionId)),
		);
	};
	try {
		assertProjectRoot(directory);
	} catch {
		outcome.unreadable = true;
		clearLineage();
		return outcome;
	}
	const listRows = (): ReturnType<
		typeof listCoordinationStateRowsRaw
	> | null => {
		try {
			return _scopePersistenceInternals.listResetSweepRows(directory);
		} catch {
			return null;
		}
	};
	const pageSize = Math.min(
		bindingFileScanCapacity,
		MAX_COORDINATION_STATE_LIST_ROWS,
	);
	// Page while rows are being removed: every removal pulls rows past the
	// scan capacity into the next page.
	for (let pass = 0; ; pass += 1) {
		const rows = listRows();
		if (rows === null) {
			outcome.unreadable = true;
			break;
		}
		let passRemoved = 0;
		for (const row of rows) {
			const generationId = row.entityKey;
			const { kind, parsed } = attributionOf(row.payload);
			// Unparseable, or an object no session can claim: the realistic
			// corruption (final-critic F2: the recovery command must survive
			// corrupt rows). Counted for operator cleanup and never removed on
			// a guess. Whatever the sweep established about this row before is
			// replaced.
			if (kind === 'unparseable' || kind === 'unattributable') {
				classify(generationId, 'unidentifiable');
				continue;
			}
			if (kind !== 'wanted' || parsed === null) {
				// Someone else's row now. If an attempt on an earlier listing is
				// unresolved, the row the sweep tried to retire is no longer the
				// reset sessions' — reported as such, never silently dropped.
				// Otherwise nothing of theirs is left for this key. An earlier
				// cleared status stands.
				if (pending.get(generationId) === 'unconfirmed')
					relinquishedKeys.add(generationId);
				pending.delete(generationId);
				continue;
			}
			// Attributable to the reset sessions: whatever the sweep established
			// before is replaced by the outcome of this attempt.
			classify(generationId, null);
			const bindingId =
				typeof parsed.bindingId === 'string' ? parsed.bindingId : '';
			const taskId = typeof parsed.taskId === 'string' ? parsed.taskId : '';
			const expiresAt =
				typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0;
			// Only the retirement is allowed to leave a row unconfirmed. The
			// bookkeeping and the shadow cleanup run once it has committed,
			// outside the catch. The sink is given the payload this listing
			// observed: the retirement is confirmed only of exactly that row.
			let retired = false;
			try {
				withCoordinationTransaction(directory, () => {
					const failure = retireScopeBindingGenerationWithinTransaction(
						directory,
						{ bindingId, generationId, revision: row.revision, expiresAt },
						'revoked',
						row.payload,
					);
					if (failure)
						throw new Error(failure.ok ? 'unreachable' : failure.message);
				});
				retired = true;
			} catch {
				// Read again before it is reported: the attempt may have missed a
				// row a concurrent writer had just changed, or committed and
				// then thrown.
				classify(generationId, 'unconfirmed');
			}
			if (retired) {
				removedKeys.add(generationId);
				passRemoved += 1;
				removeScopeBindingShadow(directory, {
					taskId,
					bindingId,
					generationId,
				});
			}
		}
		// A short page proves the store was seen in full. A full page never
		// does: one that removed nothing may hide rows of the reset sessions
		// past the capacity, and the pass limit ends a sweep that was still
		// progressing. Both are reported as truncated, never claimed swept.
		if (rows.length < pageSize) break;
		if (passRemoved === 0 || pass + 1 >= MAX_RESET_SWEEP_PASSES) {
			outcome.truncated = true;
			break;
		}
	}
	// Read again every row whose last attempt threw, before reporting it. A
	// concurrent writer may have removed, re-attributed or corrupted it since,
	// and an attempt that committed may still have thrown. No such attempt is
	// dropped: the read places the row in exactly one report.
	//   refused by the store -> unchecked (whether it remains is unknown);
	//   still theirs         -> failed;
	//   found corrupt        -> unidentifiable, as the page loop reports it;
	//   gone, or no longer the reset sessions'
	//                        -> relinquished: not cleared by this sweep's
	//                           count, and reported in its own line.
	// Each is the row's latest word, so an earlier cleared status goes with it.
	// Every key here was last LISTED as the reset sessions' (a later listing as
	// someone else's resolves it in the page loop), which is what the
	// unchecked line says of it.
	const failedKeys = new Set<string>();
	const uncheckedKeys = new Set<string>();
	for (const [generationId, mark] of [...pending]) {
		if (mark !== 'unconfirmed') continue;
		let row: ReturnType<typeof _scopePersistenceInternals.readResetSweepRow>;
		try {
			row = _scopePersistenceInternals.readResetSweepRow(
				directory,
				generationId,
			);
		} catch {
			classify(generationId, null);
			uncheckedKeys.add(generationId);
			continue;
		}
		classify(generationId, null);
		const kind = row === null ? 'gone' : attributionOf(row.payload).kind;
		if (kind === 'wanted') failedKeys.add(generationId);
		else if (kind === 'unparseable' || kind === 'unattributable')
			classify(generationId, 'unidentifiable');
		else relinquishedKeys.add(generationId);
	}
	// Every key is in at most one of these: an 'unconfirmed' entry was
	// resolved above into exactly one line, what is left in `pending` is
	// exactly the rows last seen unidentifiable, and a key the sweep saw again
	// in any unresolved state left `removedKeys` and `relinquishedKeys` when
	// it did.
	outcome.removed = removedKeys.size;
	outcome.unidentifiable = pending.size;
	outcome.failed = failedKeys.size;
	outcome.unchecked = uncheckedKeys.size;
	outcome.unconfirmedRelinquished = relinquishedKeys.size;
	clearLineage();
	return outcome;
}

export const _scopePersistenceInternals = {
	// Narrow DI seam for faulting one rollback transition in regression tests.
	transitionScopeBindingState,
	// Narrow DI seam for faulting the terminal sink in compensation-failure
	// regression tests (#3889 plan obligation 5).
	retireScopeBindingGenerationWithinTransaction,
	transitionScopeBindingStateWithinTransaction,
	// Narrow DI seam for exercising the compare-and-remove interleavings of
	// obligation 7 (wrong revision / foreign kind must survive).
	releaseAdmissionPending,
	// Narrow DI seam for faulting the reset sweep's row enumeration (an
	// unreadable store — final-critic round-2 N2).
	listResetSweepRows: (directory: string) =>
		listCoordinationStateRowsRaw(
			directory,
			SCOPE_BINDING_COORDINATION_NAMESPACE,
			bindingFileScanCapacity,
		),
	// Narrow DI seam for faulting the reset sweep's final read of a row it
	// could not retire (the store refusing that read).
	readResetSweepRow: (directory: string, generationId: string) =>
		getCoordinationStateRaw(
			directory,
			SCOPE_BINDING_COORDINATION_NAMESPACE,
			generationId,
		),
	get liveBindingCapacity(): number {
		return liveBindingCapacity;
	},
	set liveBindingCapacity(value: number) {
		liveBindingCapacity = Math.max(1, Math.floor(value));
	},
	get bindingFileScanCapacity(): number {
		return bindingFileScanCapacity;
	},
	set bindingFileScanCapacity(value: number) {
		bindingFileScanCapacity = Math.max(1, Math.floor(value));
	},
	get maintenanceFileScanCapacity(): number {
		return maintenanceFileScanCapacity;
	},
	set maintenanceFileScanCapacity(value: number) {
		maintenanceFileScanCapacity = Math.max(1, Math.floor(value));
	},
};

/**
 * Read persisted scope for a task. Returns null on:
 *   - file missing
 *   - file is a symlink (lstat guard — prevents hostile repo pre-seeding)
 *   - unknown schema version (fail-closed)
 *   - expired TTL
 *   - malformed JSON
 *   - invalid taskId
 */
export function readScopeFromDisk(
	directory: string,
	taskId: string,
): string[] | null {
	if (!isSafeTaskId(taskId)) return null;
	const scopesDir = getScopesDir(directory);
	if (!isScopesDirSafe(directory, scopesDir)) return null;
	const scopePath = getScopeFilePath(directory, taskId);

	// Open with O_NOFOLLOW + fstat to close the leaf-file TOCTOU window.
	// fs.readFileSync follows symlinks; a separate fd-based read does not.
	const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	let fd: number;
	try {
		fd = fs.openSync(scopePath, fs.constants.O_RDONLY | nofollow);
	} catch {
		return null;
	}

	let raw: string;
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile()) return null;
		if (stat.size > MAX_SCOPE_BYTES) return null;
		const buf = Buffer.alloc(stat.size);
		fs.readSync(fd, buf, 0, stat.size, 0);
		raw = buf.toString('utf-8');
	} catch {
		return null;
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
	}
	if (!raw.trim()) return null;

	let parsed: Partial<PersistedScope>;
	try {
		parsed = JSON.parse(raw) as Partial<PersistedScope>;
	} catch {
		return null;
	}

	if (parsed.version !== SCOPE_SCHEMA_VERSION) return null;
	// Reject files whose stored taskId disagrees with the filename — prevents a
	// stale or attacker-planted `scope-1.1.json` from serving a different task.
	if (parsed.taskId !== taskId) return null;
	const now = Date.now();
	if (typeof parsed.declaredAt !== 'number' || parsed.declaredAt > now) {
		return null;
	}
	if (typeof parsed.expiresAt !== 'number' || now >= parsed.expiresAt) {
		return null;
	}
	if (!Array.isArray(parsed.files)) return null;
	if (parsed.files.length > MAX_FILES_PER_SCOPE) return null;
	const files = parsed.files.filter((f): f is string => typeof f === 'string');
	return files.length > 0 ? files : null;
}

/**
 * Read declared scope for a task from `.swarm/plan.json:phases[].tasks[].files_touched`.
 * Mirrors the logic in src/hooks/diff-scope.ts:15-47 but kept independent so a
 * future diff-scope refactor doesn't ripple into authority-layer reads.
 *
 * Returns null on missing plan, task not found, no files_touched, or parse error.
 */
export function readPlanScope(
	directory: string,
	taskId: string,
): string[] | null {
	if (!isSafeTaskId(taskId)) return null;
	try {
		const planPath = path.join(directory, '.swarm', 'plan.json');
		const stat = fs.statSync(planPath);
		if (!stat.isFile()) return null;
		if (stat.size > MAX_PLAN_BYTES) return null; // DoS cap

		const raw = fs.readFileSync(planPath, 'utf-8');
		const plan = JSON.parse(raw) as {
			phases?: Array<{
				tasks?: Array<{
					id?: string;
					files_touched?: string | string[];
				}>;
			}>;
		};

		for (const phase of plan.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				if (task.id !== taskId) continue;
				const ft = task.files_touched;
				if (Array.isArray(ft) && ft.length > 0) {
					if (ft.length > MAX_FILES_PER_SCOPE) return null;
					return ft.filter((f): f is string => typeof f === 'string');
				}
				if (typeof ft === 'string' && ft.length > 0) return [ft];
				return null;
			}
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Remove scope file for a single task. Called when a task transitions to
 * completed/closed so stale scope doesn't leak into later tasks with the same id.
 */
export function clearScopeForTask(directory: string, taskId: string): void {
	if (!isSafeTaskId(taskId)) return;
	try {
		assertProjectRoot(directory);
		fs.unlinkSync(getScopeFilePath(directory, taskId));
	} catch {
		/* no-op */
	}
}

/**
 * Remove the entire `.swarm/scopes/` directory. Called by /swarm close so the
 * next session starts without inherited scope.
 */
export function clearAllScopes(directory: string): void {
	try {
		assertProjectRoot(directory);
		fs.rmSync(getScopesDir(directory), { recursive: true, force: true });
	} catch {
		/* no-op */
	}
}

/**
 * Resolve scope for a task with the full fallback chain:
 *   1. in-memory session.declaredCoderScope (fast path; live process)
 *   2. `.swarm/scopes/scope-{taskId}.json` (cross-process durable)
 *   3. `.swarm/plan.json:phases[].tasks[].files_touched` (architect-authored)
 *   4. caller-supplied pending-map fallback (delegation-gate module map)
 *
 * Any null/empty result falls through to the next layer. First non-empty wins.
 */
export function resolveScopeWithFallbacks(input: {
	directory: string;
	taskId: string | null | undefined;
	inMemoryScope: string[] | null | undefined;
	pendingMapScope: string[] | null | undefined;
}): string[] | null {
	const { directory, taskId, inMemoryScope, pendingMapScope } = input;
	if (inMemoryScope && inMemoryScope.length > 0) return inMemoryScope;
	if (taskId) {
		const disk = readScopeFromDisk(directory, taskId);
		if (disk && disk.length > 0) return disk;
		const plan = readPlanScope(directory, taskId);
		if (plan && plan.length > 0) return plan;
	}
	if (pendingMapScope && pendingMapScope.length > 0) return pendingMapScope;
	return null;
}
