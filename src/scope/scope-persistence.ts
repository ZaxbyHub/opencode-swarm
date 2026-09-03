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
	deleteCoordinationState,
	getProjectDb,
	importCoordinationOnce,
	listCoordinationStates,
	transitionCoordinationState,
	withCoordinationTransaction,
} from '../db';
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
	clearSweepTombstoneForRevival,
	createClaimedScopeBinding,
	DEFAULT_SCOPE_BINDING_TTL_MS,
	hasDeliberateScopeBindingDenyOverlay,
	hasScopeBindingDenyOverlay,
	installFailedRevocationOverlay,
	installScopeBindingRetirementIntent,
	installScopeBindingTombstone,
	isScopeBindingIdentity,
	MAX_PENDING_SCOPE_BINDINGS,
	normalizeScopeFiles,
	registerScopeBinding,
	type ScopeBinding,
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

export type DurableScopeBindingResolution =
	| { status: 'found'; binding: ScopeBinding }
	| { status: 'expired'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'ambiguous'; candidates: ScopeBinding[]; totalCandidates: number }
	| { status: 'overloaded' }
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
		if (
			normalizePathForComparison(path.dirname(candidate)) !==
				normalizePathForComparison(scopesDir) ||
			normalizePathForComparison(resolvedCandidate) !==
				normalizePathForComparison(candidate)
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
			normalizePathForComparison(finalResolvedCandidate) !==
				normalizePathForComparison(candidate) ||
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
		if (
			listCoordinationStates(directory, SCOPE_BINDING_COORDINATION_NAMESPACE, 1)
				.length > 0
		) {
			return { ok: true, value: undefined };
		}
		const legacy = collectLegacyScopeBindingsForImport(directory);
		if (legacy.rowCount === 0 && legacy.authorityFiles.length === 0) {
			return { ok: true, value: undefined };
		}
		const importedBindings = legacy.bindings.map((binding) => ({ ...binding }));
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
		if (outcome === 'imported') {
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
		const liveCount = complete.filter(
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
		return { ok: true, value: complete };
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
		if (completeSet.code === 'SCOPE_BINDING_STORE_OVERLOADED') {
			scheduleScopeBindingMaintenance(input.directory);
		}
		return { status: 'overloaded' };
	}
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
	const live = candidates.filter(
		(candidate) =>
			candidate.lifecycleState === 'live' && candidate.expiresAt > Date.now(),
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
			candidate.lifecycleState !== 'live' || candidate.expiresAt <= Date.now(),
	);
	return input.includeExpired && expired.length > 0
		? {
				status: 'expired',
				candidates: expired.slice(0, 8),
				totalCandidates: expired.length,
			}
		: { status: 'not_declared' };
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
	const retired = transitionScopeBindingState(
		input.directory,
		tombstone,
		current.revision,
	);
	if (!retired.ok) return retired;
	installScopeBindingTombstone(retired.value);
	writeScopeBindingShadow(input.directory, retired.value);
	scheduleScopeBindingMaintenance(input.directory);
	return retired;
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
	const persisted = transitionScopeBindingState(
		directory,
		tombstone,
		current.revision,
	);
	if (!persisted.ok) {
		installFailedRevocationOverlay(binding, reason);
		return persisted;
	}
	clearExactScopeBinding(binding);
	installScopeBindingTombstone(persisted.value);
	writeScopeBindingShadow(directory, persisted.value);
	scheduleScopeBindingMaintenance(directory);
	return persisted;
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
		let failure: Exclude<ScopePersistenceResult, { ok: true }> | null = null;
		withCoordinationTransaction(input.directory, () => {
			const currentSet = readAllAuthoritativeScopeBindings(input.directory, {
				enforceLiveCapacity: false,
			});
			if (!currentSet.ok) {
				failure = currentSet;
				return;
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
				failure = {
					ok: false,
					code: 'SCOPE_BINDING_AMBIGUOUS',
					message:
						'Incompatible successors exist for one predecessor generation.',
				};
				return;
			}
			const existing = liveSuccessors[0];
			if (existing) {
				if (existing.ownerSessionId !== input.childSessionId) {
					failure = {
						ok: false,
						code: 'SCOPE_BINDING_ALREADY_CLAIMED',
						message:
							'This pending generation has a winner in another child session.',
					};
					return;
				}
				alreadyClaimed = existing;
				return;
			}
			if (
				!currentPredecessor ||
				currentPredecessor.lifecycleState !== 'live' ||
				currentPredecessor.expiresAt <= Date.now()
			) {
				failure = {
					ok: false,
					code: 'SCOPE_BINDING_EXPIRED',
					message: 'The pending predecessor expired before claim.',
				};
				return;
			}
			predecessor = currentPredecessor;
			const nextClaimed = createClaimedScopeBinding(predecessor, input);
			const claimedWrite = transitionScopeBindingState(
				input.directory,
				nextClaimed,
				null,
			);
			if (!claimedWrite.ok) {
				failure = claimedWrite;
				return;
			}
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
			const retiredWrite = transitionScopeBindingState(
				input.directory,
				superseded,
				predecessor.revision,
			);
			if (!retiredWrite.ok) {
				failure = retiredWrite;
				return;
			}
			claimed = claimedWrite.value;
			retired = retiredWrite.value;
		});
		if (failure) return failure;
		if (alreadyClaimed) {
			const admission = registerScopeBinding(alreadyClaimed);
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
		if (!claimed || !retired) {
			return persistenceFailure('Claim transaction did not settle a winner.');
		}
		writeScopeBindingShadow(input.directory, claimed);
		writeScopeBindingShadow(input.directory, retired);
		const admission = registerScopeBinding(claimed);
		if (!admission.ok) {
			return {
				ok: false,
				code: admission.code,
				message: admission.message,
			};
		}
		installScopeBindingTombstone(retired);
		return { ok: true, value: { previous: predecessor, claimed } };
	} catch (error) {
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
		let failure: Exclude<ScopePersistenceResult, { ok: true }> | null = null;
		withCoordinationTransaction(input.directory, () => {
			const create = transitionScopeBindingState(
				input.directory,
				binding,
				null,
			);
			if (!create.ok) {
				failure = create;
				return;
			}
			persisted = create.value;
			for (const prior of owned) {
				const superseded: ScopeBinding = {
					...prior,
					revision: prior.revision + 1,
					lifecycleState: 'superseded',
					updatedAt: create.value.updatedAt,
					expiresAt: Math.min(prior.expiresAt, create.value.updatedAt),
				};
				const result = transitionScopeBindingState(
					input.directory,
					superseded,
					prior.revision,
				);
				if (!result.ok) {
					failure = result;
					return;
				}
				retired.push(result.value);
			}
		});
		if (failure) return failure;
		if (!persisted) {
			return persistenceFailure(
				'Declaration transaction did not persist a generation.',
			);
		}
		writeScopeBindingShadow(input.directory, persisted);
		for (const prior of retired) {
			writeScopeBindingShadow(input.directory, prior);
			installScopeBindingTombstone(prior);
		}
		const admission = registerScopeBinding(persisted);
		if (!admission.ok) {
			return {
				ok: false,
				code: admission.code,
				message: admission.message,
			};
		}
		return { ok: true, value: persisted };
	} catch (error) {
		return persistenceFailure(
			`Declaration transaction failed: ${
				error instanceof Error ? error.message : 'unknown coordination error'
			}`,
		);
	}
}

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
		.finally(() => maintenanceJobs.delete(key));
	maintenanceJobs.set(key, job);
}

export async function flushScopeBindingMaintenance(
	directory?: string,
): Promise<void> {
	const key = directory
		? canonicalExistingFilesystemPath(directory)
		: undefined;
	if (directory && key === null) return;
	const job = key ? maintenanceJobs.get(key) : undefined;
	await Promise.all(job ? [job] : [...maintenanceJobs.values()]);
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
		const tombstones = all
			.filter((binding) => binding.lifecycleState !== 'live')
			.sort((left, right) => left.updatedAt - right.updatedAt);
		const now = Date.now();
		const removable = tombstones.filter(
			(binding, index) =>
				now - binding.updatedAt > MAX_TOMBSTONE_AGE_MS ||
				index < tombstones.length - MAX_DURABLE_TOMBSTONES,
		);
		let removed = 0;
		for (const binding of removable) {
			const filePath = resolveSafeScopeFileForUnlink(
				directory,
				getBindingFilePath(directory, binding),
			);
			if (!filePath) continue;
			const exactLockPath = getGenerationLockPath(filePath);
			if (!(await ensureLockTarget(exactLockPath))) continue;
			let releaseExact: (() => Promise<void>) | undefined;
			let removedExact = false;
			try {
				releaseExact = await lockfile.lock(exactLockPath, {
					stale: LOCK_STALE_MS,
					retries: { retries: 0 },
					realpath: false,
				});
				const latestRaw = readBoundedFile(filePath);
				const latest = latestRaw
					? validateScopeBindingPayload(
							directory,
							JSON.parse(latestRaw) as Partial<ScopeBinding>,
						)
					: null;
				if (
					!latest ||
					latest.generationId !== binding.generationId ||
					latest.revision !== binding.revision ||
					(latest.lifecycleState === 'live' &&
						!hasDurableRetirementIntent(filePath, latest))
				)
					continue;
				deleteCoordinationState(
					directory,
					SCOPE_BINDING_COORDINATION_NAMESPACE,
					binding.generationId,
					binding.revision,
				);
				fs.unlinkSync(filePath);
				removedExact = true;
				removed++;
			} catch {
				/* changed concurrently */
			} finally {
				if (releaseExact)
					try {
						await releaseExact();
					} catch {
						/* stale/released */
					}
			}
			if (removedExact && !fs.existsSync(filePath)) {
				try {
					fs.unlinkSync(exactLockPath);
				} catch {
					/* another runtime adopted or removed the target */
				}
				try {
					fs.unlinkSync(getRetirementIntentPath(filePath));
				} catch {
					/* settled intent already removed */
				}
			}
		}
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
				let receipt: ScopeClaimReceipt | null = null;
				try {
					receipt = JSON.parse(raw) as ScopeClaimReceipt;
				} catch {
					/* malformed receipts are removable once old */
				}
				const winner = receipt
					? all.find(
							(binding) => binding.generationId === receipt?.winnerGenerationId,
						)
					: undefined;
				const old =
					Date.now() - fs.statSync(receiptPath).mtimeMs > MAX_TOMBSTONE_AGE_MS;
				if (
					old ||
					Boolean(
						winner &&
							(winner.lifecycleState !== 'live' ||
								winner.expiresAt <= Date.now()),
					)
				) {
					fs.unlinkSync(receiptPath);
					removed++;
				}
			} catch {
				/* active or changed receipt */
			} finally {
				if (releaseReceipt)
					try {
						await releaseReceipt();
					} catch {
						/* stale/released */
					}
			}
		}
		return { ok: true, value: removed };
	} catch (error) {
		return persistenceFailure(
			`Scope maintenance failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
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

/**
 * Resolve authorization against the current durable plan projection. This is
 * synchronous so guardrail paths can use one exact source without reviving the
 * legacy session/v1/plan fallback chain.
 */
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
		return admission.ok ? durable : { status: 'overloaded' };
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

export const _scopePersistenceInternals = {
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
