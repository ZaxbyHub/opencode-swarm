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
import { computePlanStructureHash } from '../plan/ledger';
import { derivePlanId } from '../plan/utils';
import { bunWrite } from '../utils/bun-compat';
import { assertProjectRoot } from '../utils/project-boundary';
import {
	canonicalWorkspaceIdentity,
	clearExactScopeBinding,
	createClaimedScopeBinding,
	DEFAULT_SCOPE_BINDING_TTL_MS,
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
const syncLockWait = new Int32Array(new SharedArrayBuffer(4));

function lockSyncWithBoundedRetry(
	targetPath: string,
	attempts = 41,
): () => void {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return lockfileWithSync.lockSync(targetPath, {
				stale: LOCK_STALE_MS,
				realpath: false,
			});
		} catch (error) {
			lastError = error;
			if (attempt + 1 < attempts) Atomics.wait(syncLockWait, 0, 0, 25);
		}
	}
	throw lastError instanceof Error ? lastError : new Error('Lock unavailable');
}

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

function exactBindingPrefix(taskId: string): string {
	return `binding-${taskId}-`;
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
	const files = Array.isArray(parsed.files)
		? normalizeScopeFiles(
				parsed.files.filter((file): file is string => typeof file === 'string'),
			)
		: null;
	if (
		parsed.version !== 2 ||
		!workspaceIdentity ||
		parsed.workspaceIdentity !== workspaceIdentity ||
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
	filePath: string,
	binding: ScopeBinding,
): boolean {
	return (
		normalizePathForComparison(filePath) ===
		normalizePathForComparison(
			getBindingFilePath(binding.workspaceIdentity, binding),
		)
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
					const temp = `${exactPath}.migration-${process.pid}`;
					fs.writeFileSync(temp, JSON.stringify(binding, null, 2), {
						flag: 'wx',
					});
					fs.renameSync(temp, exactPath);
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

	const scopesDir = getScopesDir(directory);
	const scopePath = getBindingFilePath(directory, binding);
	try {
		fs.mkdirSync(scopesDir, { recursive: true });
	} catch {
		return persistenceFailure('Could not create the durable scope store.');
	}
	if (!isScopesDirSafe(directory, scopesDir))
		return persistenceFailure(
			'The durable scope store failed containment checks.',
		);

	const content = JSON.stringify({ ...binding, files }, null, 2);
	try {
		const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT;
		const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		const fd = fs.openSync(scopePath, flags | nofollow);
		fs.closeSync(fd);
	} catch {
		return persistenceFailure('Could not create the exact generation record.');
	}

	let release: (() => Promise<void>) | undefined;
	try {
		const lockPath = getGenerationLockPath(scopePath);
		if (!(await ensureLockTarget(lockPath)))
			return persistenceFailure('Could not prepare exact generation lock.');
		release = await lockfile.lock(lockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
			realpath: false,
		});
		await atomicWrite(scopePath, content);
		const verifiedRaw = readBoundedFile(scopePath);
		const verified = verifiedRaw
			? validateScopeBindingPayload(
					directory,
					JSON.parse(verifiedRaw) as Partial<ScopeBinding>,
				)
			: null;
		if (
			!verified ||
			verified.bindingId !== binding.bindingId ||
			verified.generationId !== binding.generationId ||
			verified.revision !== binding.revision
		)
			return persistenceFailure(
				'Exact generation verification failed after write.',
			);
		return { ok: true, value: verified };
	} catch (error) {
		return persistenceFailure(
			`Exact generation write failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
		);
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
	const completeSet = readAllExactBindings(input.directory);
	if (!completeSet) {
		scheduleScopeBindingMaintenance(input.directory);
		return { status: 'overloaded' };
	}
	const candidates = completeSet.filter(
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
	let release: (() => void) | undefined;
	try {
		const resolvedWorkspace = fs.realpathSync(input.directory);
		const scopePath = getBindingFilePath(resolvedWorkspace, input.binding);
		if (!isScopesDirSafe(resolvedWorkspace, getScopesDir(resolvedWorkspace)))
			return persistenceFailure(
				'The durable scope store failed containment checks.',
			);
		const retirementIntentPath = getRetirementIntentPath(scopePath);
		atomicWriteSync(
			retirementIntentPath,
			JSON.stringify({
				version: 1,
				bindingId: input.binding.bindingId,
				generationId: input.binding.generationId,
				createdAt: Date.now(),
			}),
		);
		// If bounded synchronous lock acquisition loses to a slow writer, the
		// durable intent denies immediately and maintenance finishes retirement.
		scheduleScopeBindingMaintenance(resolvedWorkspace);
		const lockPath = getGenerationLockPath(scopePath);
		if (!ensureLockTargetSync(lockPath))
			return persistenceFailure('Could not prepare exact retirement lock.');
		release = lockSyncWithBoundedRetry(lockPath);
		const raw = readBoundedFile(scopePath);
		if (!raw) {
			try {
				fs.unlinkSync(retirementIntentPath);
			} catch {
				/* already absent */
			}
			return localRetirement
				? { ok: true, value: localRetirement }
				: persistenceFailure(
						'Exact generation disappeared before serialized retirement.',
					);
		}
		const current = validateScopeBindingPayload(
			resolvedWorkspace,
			JSON.parse(raw) as Partial<ScopeBinding>,
		);
		if (
			!current ||
			current.bindingId !== input.binding.bindingId ||
			current.generationId !== input.binding.generationId
		)
			return persistenceFailure(
				'Exact generation identity changed before serialized retirement.',
			);
		if (current.lifecycleState !== 'live') {
			installScopeBindingTombstone(current);
			try {
				fs.unlinkSync(retirementIntentPath);
			} catch {
				/* settled intent already removed */
			}
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
		atomicWriteSync(scopePath, JSON.stringify(tombstone, null, 2));
		const verifiedRaw = readBoundedFile(scopePath);
		const verified = verifiedRaw
			? validateScopeBindingPayload(
					resolvedWorkspace,
					JSON.parse(verifiedRaw) as Partial<ScopeBinding>,
				)
			: null;
		if (
			!verified ||
			verified.revision !== tombstone.revision ||
			verified.lifecycleState !== 'revoked'
		)
			return persistenceFailure('Serialized retirement verification failed.');
		installScopeBindingTombstone(verified);
		try {
			fs.unlinkSync(retirementIntentPath);
		} catch {
			/* durable tombstone is authoritative */
		}
		scheduleScopeBindingMaintenance(resolvedWorkspace);
		return { ok: true, value: verified };
	} catch (error) {
		return persistenceFailure(
			`Serialized retirement failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
		);
	} finally {
		try {
			release?.();
		} catch {
			/* stale/released */
		}
	}
}

export async function tombstoneScopeBinding(
	directory: string,
	binding: ScopeBinding,
	reason: 'expired' | 'revoked' | 'superseded',
): Promise<ScopePersistenceResult> {
	const currentPath = getBindingFilePath(directory, binding);
	const generationLockPath = getGenerationLockPath(currentPath);
	const lockReady = await ensureLockTarget(generationLockPath);
	if (!lockReady) {
		installFailedRevocationOverlay(binding, reason);
		return persistenceFailure('Could not prepare exact generation lock.');
	}
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(generationLockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
			realpath: false,
		});
		const raw = readBoundedFile(currentPath);
		if (!raw) {
			installFailedRevocationOverlay(binding, reason);
			return persistenceFailure(
				'Exact generation disappeared before tombstone.',
			);
		}
		const current = validateScopeBindingPayload(
			directory,
			JSON.parse(raw) as Partial<ScopeBinding>,
		);
		if (
			!current ||
			current.bindingId !== binding.bindingId ||
			current.generationId !== binding.generationId
		) {
			installFailedRevocationOverlay(binding, reason);
			return persistenceFailure(
				'Exact generation identity changed before tombstone.',
			);
		}
		if (current.revision !== binding.revision)
			return {
				ok: false,
				code: 'SCOPE_BINDING_STALE',
				message: 'Tombstone CAS revision is stale.',
			};
		if (current.lifecycleState !== 'live') return { ok: true, value: current };
		const now = Date.now();
		const tombstone: ScopeBinding = {
			...current,
			revision: current.revision + 1,
			lifecycleState: reason,
			updatedAt: now,
			expiresAt: Math.min(current.expiresAt, now),
		};
		await atomicWrite(currentPath, JSON.stringify(tombstone, null, 2));
		const verifiedRaw = readBoundedFile(currentPath);
		const verified = verifiedRaw
			? validateScopeBindingPayload(
					directory,
					JSON.parse(verifiedRaw) as Partial<ScopeBinding>,
				)
			: null;
		if (
			!verified ||
			verified.revision !== tombstone.revision ||
			verified.lifecycleState !== reason
		) {
			installFailedRevocationOverlay(binding, reason);
			return persistenceFailure('Tombstone verification failed.');
		}
		clearExactScopeBinding(binding);
		installScopeBindingTombstone(verified);
		scheduleScopeBindingMaintenance(directory);
		return { ok: true, value: verified };
	} catch (error) {
		installFailedRevocationOverlay(binding, reason);
		return persistenceFailure(
			`Tombstone failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
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
	let scopePath: string;
	try {
		scopePath = getBindingFilePath(input.directory, input);
	} catch {
		return persistenceFailure('Invalid refresh identity.');
	}
	const generationLockPath = getGenerationLockPath(scopePath);
	const createdGenerationLockTarget = !fs.existsSync(generationLockPath);
	if (!(await ensureLockTarget(generationLockPath)))
		return persistenceFailure('Could not prepare refresh lock.');
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(generationLockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 3, minTimeout: 50, maxTimeout: 200 },
			realpath: false,
		});
		if (hasDurableRetirementIntent(scopePath, input))
			return {
				ok: false,
				code: 'SCOPE_BINDING_STALE',
				message:
					'Refresh cannot renew a generation with durable retirement intent.',
			};
		const raw = readBoundedFile(scopePath);
		const current = raw
			? validateScopeBindingPayload(
					input.directory,
					JSON.parse(raw) as Partial<ScopeBinding>,
				)
			: null;
		if (
			!current ||
			current.bindingId !== input.bindingId ||
			current.generationId !== input.generationId ||
			current.taskId !== input.taskId ||
			current.ownerSessionId !== input.activeSessionId
		)
			return {
				ok: false,
				code: 'SCOPE_BINDING_STALE',
				message:
					'Refresh identity is not the exact current session/task generation.',
			};
		if (
			current.lifecycleState !== 'live' ||
			current.expiresAt <= Date.now() ||
			current.revision !== input.expectedRevision
		)
			return {
				ok: false,
				code:
					current.expiresAt <= Date.now()
						? 'SCOPE_BINDING_EXPIRED'
						: 'SCOPE_BINDING_STALE',
				message:
					'Refresh cannot renew an expired, tombstoned, or stale generation.',
			};
		const now = Date.now();
		const refreshed: ScopeBinding = {
			...current,
			revision: current.revision + 1,
			updatedAt: now,
			leaseStartedAt: now,
			expiresAt: now + Math.max(1, input.ttlMs ?? DEFAULT_SCOPE_BINDING_TTL_MS),
		};
		await atomicWrite(scopePath, JSON.stringify(refreshed, null, 2));
		const verifyRaw = readBoundedFile(scopePath);
		const verified = verifyRaw
			? validateScopeBindingPayload(
					input.directory,
					JSON.parse(verifyRaw) as Partial<ScopeBinding>,
				)
			: null;
		if (
			!verified ||
			verified.revision !== refreshed.revision ||
			verified.expiresAt !== refreshed.expiresAt
		)
			return persistenceFailure('Refreshed lease verification failed.');
		updateExactScopeBinding(verified);
		return { ok: true, value: verified };
	} catch (error) {
		return persistenceFailure(
			`Lease refresh failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
		);
	} finally {
		if (release)
			try {
				await release();
			} catch {
				/* stale/released */
			}
		if (createdGenerationLockTarget && !fs.existsSync(scopePath)) {
			try {
				fs.unlinkSync(generationLockPath);
			} catch {
				/* another runtime adopted the stable target */
			}
		}
	}
}

interface ScopeClaimReceipt {
	version: 1;
	predecessorGenerationId: string;
	winnerGenerationId: string;
	childSessionId: string;
	dispatchCallId: string;
	createdAt: number;
}

function claimBaseName(binding: ScopeBinding): string {
	const digest = createHash('sha256')
		.update(
			`${binding.bindingId}\0${binding.generationId}\0${binding.dispatchCallId ?? ''}`,
		)
		.digest('hex')
		.slice(0, 40);
	return `claim-${digest}`;
}

function readAllExactBindings(
	directory: string,
	options: { enforceLiveCapacity?: boolean; maintenanceScan?: boolean } = {},
): ScopeBinding[] | null {
	const scopesDir = getScopesDir(directory);
	try {
		fs.lstatSync(scopesDir);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
	}
	if (!isScopesDirSafe(directory, scopesDir)) return null;
	const scanCapacity = options.maintenanceScan
		? maintenanceFileScanCapacity
		: bindingFileScanCapacity;
	if (!migrateLegacyBindingsSync(directory, scanCapacity)) return null;
	let names: string[];
	try {
		names = fs.readdirSync(scopesDir).sort();
	} catch {
		return [];
	}
	if (names.length > scanCapacity) return null;
	const bindings: ScopeBinding[] = [];
	for (const name of names) {
		if (!name.startsWith('binding-') || !name.endsWith('.json')) continue;
		const filePath = path.join(scopesDir, name);
		const raw = readBoundedFile(filePath);
		if (!raw) continue;
		try {
			const binding = validateScopeBindingPayload(
				directory,
				JSON.parse(raw) as Partial<ScopeBinding>,
			);
			if (binding && exactFilenameMatches(filePath, binding)) {
				if (hasDurableRetirementIntent(filePath, binding)) {
					let createdAt = Date.now();
					try {
						const rawIntent = readBoundedFile(
							getRetirementIntentPath(filePath),
						);
						const parsedIntent = rawIntent
							? (JSON.parse(rawIntent) as { createdAt?: unknown })
							: null;
						if (typeof parsedIntent?.createdAt === 'number')
							createdAt = parsedIntent.createdAt;
					} catch {
						/* identity-valid intent remains immediately effective */
					}
					bindings.push({
						...binding,
						lifecycleState: 'revoked',
						updatedAt: createdAt,
						expiresAt: Math.min(binding.expiresAt, createdAt),
					});
				} else bindings.push(binding);
			}
		} catch {
			/* malformed records never authorize */
		}
	}
	const liveCount = bindings.filter(
		(binding) =>
			binding.lifecycleState === 'live' && binding.expiresAt > Date.now(),
	).length;
	if (options.enforceLiveCapacity !== false && liveCount > liveBindingCapacity)
		return null;
	return bindings;
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
	const initial = readAllExactBindings(input.directory);
	if (!initial)
		return {
			ok: false,
			code: 'SCOPE_BINDING_STORE_OVERLOADED',
			message: 'The complete durable binding set could not be evaluated.',
		};
	const pending = initial.filter(
		(binding) =>
			binding.lifecycleState === 'live' &&
			binding.expiresAt > Date.now() &&
			binding.activation === 'pending_child' &&
			binding.ownerSessionId === input.parentSessionId &&
			binding.dispatchCallId === input.dispatchCallId &&
			binding.ownerMessageId === input.dispatchCallId,
	);
	if (pending.length > 1)
		return {
			ok: false,
			code: 'SCOPE_BINDING_AMBIGUOUS',
			message: 'Multiple pending generations match this exact Task dispatch.',
		};
	let predecessor = pending[0];
	if (!predecessor) {
		const successors = initial.filter(
			(binding) =>
				binding.lifecycleState === 'live' &&
				binding.expiresAt > Date.now() &&
				binding.activation === 'active' &&
				binding.parentOwnerSessionId === input.parentSessionId &&
				binding.dispatchCallId === input.dispatchCallId &&
				binding.predecessorGenerationId,
		);
		if (successors.length > 1)
			return {
				ok: false,
				code: 'SCOPE_BINDING_AMBIGUOUS',
				message: 'Multiple active successors match this Task dispatch.',
			};
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
			: initial.some(
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

	const claimPath = path.join(
		getScopesDir(input.directory),
		`${claimBaseName(predecessor)}.json`,
	);
	if (!(await ensureLockTarget(claimPath)))
		return persistenceFailure(
			'Could not prepare the stable predecessor claim lock.',
		);
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(claimPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 5, minTimeout: 50, maxTimeout: 250 },
			realpath: false,
		});
		const currentSet = readAllExactBindings(input.directory);
		if (!currentSet)
			return {
				ok: false,
				code: 'SCOPE_BINDING_STORE_OVERLOADED',
				message: 'The durable binding set became incomplete during claim.',
			};
		const currentPredecessor = currentSet.find(
			(binding) =>
				binding.generationId === predecessor.generationId &&
				binding.bindingId === predecessor.bindingId,
		);
		const allSuccessors = currentSet.filter(
			(binding) =>
				binding.predecessorGenerationId === predecessor.generationId &&
				binding.bindingId === predecessor.bindingId,
		);
		const successors = allSuccessors.filter(
			(binding) =>
				binding.lifecycleState === 'live' && binding.expiresAt > Date.now(),
		);
		if (successors.length > 1)
			return {
				ok: false,
				code: 'SCOPE_BINDING_AMBIGUOUS',
				message:
					'Incompatible successors exist for one predecessor generation.',
			};
		const receiptRaw = readBoundedFile(claimPath);
		let receipt: ScopeClaimReceipt | null = null;
		if (receiptRaw) {
			try {
				const parsed = JSON.parse(receiptRaw) as Partial<ScopeClaimReceipt>;
				if (
					parsed.version !== 1 ||
					parsed.predecessorGenerationId !== predecessor.generationId ||
					!isScopeBindingIdentity(parsed.winnerGenerationId) ||
					typeof parsed.childSessionId !== 'string' ||
					parsed.dispatchCallId !== input.dispatchCallId
				)
					return persistenceFailure(
						'Claim winner receipt is malformed or belongs to another predecessor.',
					);
				receipt = parsed as ScopeClaimReceipt;
			} catch {
				return persistenceFailure('Claim winner receipt is malformed.');
			}
		}
		if (receipt) {
			const receiptWinner = allSuccessors.find(
				(candidate) => candidate.generationId === receipt?.winnerGenerationId,
			);
			if (!receiptWinner)
				return persistenceFailure(
					'Claim receipt has no verified successor; pending remains fail-closed for restart reconciliation.',
				);
			if (
				receiptWinner.lifecycleState !== 'live' ||
				receiptWinner.expiresAt <= Date.now()
			) {
				// A failed publication deliberately tombstones its successor. The receipt
				// is then settled evidence, not a permanent poison pill for the predecessor.
				fs.writeFileSync(claimPath, '');
				receipt = null;
			}
		}
		if (
			receipt &&
			successors[0] &&
			receipt.winnerGenerationId !== successors[0].generationId
		)
			return {
				ok: false,
				code: 'SCOPE_BINDING_AMBIGUOUS',
				message: 'Claim receipt and durable successor disagree.',
			};
		const existing = successors[0];
		if (existing) {
			if (existing.ownerSessionId !== input.childSessionId)
				return {
					ok: false,
					code: 'SCOPE_BINDING_ALREADY_CLAIMED',
					message:
						'This pending generation has a winner in another child session.',
				};
			await writeClaimReceipt(claimPath, predecessor, existing, input);
			if (currentPredecessor?.lifecycleState === 'live')
				await tombstoneScopeBinding(
					input.directory,
					currentPredecessor,
					'superseded',
				);
			const admission = registerScopeBinding(existing);
			return admission.ok
				? { ok: true, value: { previous: predecessor, claimed: existing } }
				: {
						ok: false,
						code: admission.code,
						message: admission.message,
					};
		}
		if (
			!currentPredecessor ||
			currentPredecessor.lifecycleState !== 'live' ||
			currentPredecessor.expiresAt <= Date.now()
		)
			return {
				ok: false,
				code: 'SCOPE_BINDING_EXPIRED',
				message: 'The pending predecessor expired before claim.',
			};
		predecessor = currentPredecessor;
		const claimed = createClaimedScopeBinding(predecessor, input);
		const persisted = await writeScopeBindingToDisk(input.directory, claimed);
		if (!persisted.ok) return persisted;
		const receiptWrite = await writeClaimReceipt(
			claimPath,
			predecessor,
			persisted.value,
			input,
		);
		if (!receiptWrite.ok) {
			await tombstoneScopeBinding(input.directory, persisted.value, 'revoked');
			return receiptWrite;
		}
		const admission = registerScopeBinding(persisted.value);
		if (!admission.ok) {
			await tombstoneScopeBinding(input.directory, persisted.value, 'revoked');
			return {
				ok: false,
				code: admission.code,
				message: admission.message,
			};
		}
		const retired = await tombstoneScopeBinding(
			input.directory,
			predecessor,
			'superseded',
		);
		if (!retired.ok) {
			await tombstoneScopeBinding(input.directory, persisted.value, 'revoked');
			return persistenceFailure(
				`Successor was persisted but predecessor retirement failed: ${retired.message}`,
			);
		}
		return {
			ok: true,
			value: { previous: predecessor, claimed: persisted.value },
		};
	} catch (error) {
		return persistenceFailure(
			`Claim transaction failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
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

async function writeClaimReceipt(
	claimPath: string,
	previous: ScopeBinding,
	claimed: ScopeBinding,
	input: { childSessionId: string; dispatchCallId: string },
): Promise<ScopePersistenceResult<ScopeClaimReceipt>> {
	const receipt: ScopeClaimReceipt = {
		version: 1,
		predecessorGenerationId: previous.generationId,
		winnerGenerationId: claimed.generationId,
		childSessionId: input.childSessionId,
		dispatchCallId: input.dispatchCallId,
		createdAt: Date.now(),
	};
	try {
		await atomicWrite(claimPath, JSON.stringify(receipt, null, 2));
		const raw = readBoundedFile(claimPath);
		const verified = raw ? (JSON.parse(raw) as ScopeClaimReceipt) : null;
		return verified?.winnerGenerationId === receipt.winnerGenerationId &&
			verified.childSessionId === receipt.childSessionId
			? { ok: true, value: verified }
			: persistenceFailure('Claim winner receipt verification failed.');
	} catch (error) {
		return persistenceFailure(
			`Claim winner receipt write failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
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
	const digest = createHash('sha256')
		.update(
			`${binding.workspaceIdentity}\0${binding.taskId}\0${binding.ownerSessionId}`,
		)
		.digest('hex')
		.slice(0, 40);
	const lockPath = path.join(
		getScopesDir(input.directory),
		`declaration-${digest}.lock-target`,
	);
	if (!(await ensureLockTarget(lockPath)))
		return persistenceFailure(
			'Could not prepare declaration transaction lock.',
		);
	let release: (() => Promise<void>) | undefined;
	try {
		release = await lockfile.lock(lockPath, {
			stale: LOCK_STALE_MS,
			retries: { retries: 5, minTimeout: 50, maxTimeout: 250 },
			realpath: false,
		});
		const all = readAllExactBindings(input.directory);
		if (!all)
			return {
				ok: false,
				code: 'SCOPE_BINDING_STORE_OVERLOADED',
				message: 'The durable binding set cannot be completely evaluated.',
			};
		const owned = all.filter(
			(candidate) =>
				candidate.lifecycleState === 'live' &&
				candidate.expiresAt > Date.now() &&
				candidate.workspaceIdentity === binding.workspaceIdentity &&
				candidate.taskId === binding.taskId &&
				candidate.ownerSessionId === binding.ownerSessionId &&
				candidate.generationId !== binding.generationId,
		);
		if (owned.length > 0 && !input.replaceExisting)
			return {
				ok: false,
				code: 'SCOPE_BINDING_AMBIGUOUS',
				message:
					'A live owned generation already exists; retry declare_scope with replace_existing=true to revoke it atomically.',
			};
		const persisted = await writeScopeBindingToDisk(input.directory, binding);
		if (!persisted.ok) return persisted;
		for (const prior of owned) {
			const retired = await tombstoneScopeBinding(
				input.directory,
				prior,
				'superseded',
			);
			if (!retired.ok) {
				await tombstoneScopeBinding(
					input.directory,
					persisted.value,
					'revoked',
				);
				return persistenceFailure(
					`Replacement could not retire generation ${prior.generationId}: ${retired.message}`,
				);
			}
		}
		const admission = registerScopeBinding(persisted.value);
		if (!admission.ok) {
			await tombstoneScopeBinding(input.directory, persisted.value, 'revoked');
			return {
				ok: false,
				code: admission.code,
				message: admission.message,
			};
		}
		return { ok: true, value: persisted.value };
	} catch (error) {
		return persistenceFailure(
			`Declaration transaction failed: ${error instanceof Error ? error.message : 'unknown I/O error'}`,
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

function scheduleScopeBindingMaintenance(directory: string): void {
	const key = normalizePathForComparison(directory);
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
	const key = directory ? normalizePathForComparison(directory) : undefined;
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
		let all = readAllExactBindings(directory, {
			enforceLiveCapacity: false,
			maintenanceScan: true,
		});
		if (!all)
			return {
				ok: false,
				code: 'SCOPE_BINDING_STORE_OVERLOADED',
				message: 'The durable binding set cannot be completely evaluated.',
			};
		for (const binding of all) {
			const filePath = getBindingFilePath(directory, binding);
			if (!hasDurableRetirementIntent(filePath, binding)) continue;
			const finalized = await tombstoneScopeBinding(
				directory,
				binding,
				'revoked',
			);
			if (finalized.ok)
				try {
					fs.unlinkSync(getRetirementIntentPath(filePath));
				} catch {
					/* durable tombstone already supersedes the intent */
				}
		}
		all = readAllExactBindings(directory, {
			enforceLiveCapacity: false,
			maintenanceScan: true,
		});
		if (!all)
			return persistenceFailure(
				'The durable binding set changed during maintenance reconciliation.',
			);
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

function readPrFeedbackBindingFile(
	directory: string,
	filePath: string,
	activeSessionId: string,
	taskId?: string,
): ScopeBinding | null {
	try {
		const leaf = fs.lstatSync(filePath);
		if (!leaf.isFile() || leaf.isSymbolicLink()) return null;
		if (
			normalizePathForComparison(fs.realpathSync(filePath)) !==
			normalizePathForComparison(filePath)
		)
			return null;
	} catch {
		return null;
	}
	const nofollow = (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | nofollow);
	} catch {
		return null;
	}
	let raw = '';
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_SCOPE_BYTES) return null;
		const buffer = Buffer.alloc(stat.size);
		fs.readSync(fd, buffer, 0, stat.size, 0);
		raw = buffer.toString('utf8');
	} catch {
		return null;
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* already closed */
		}
	}

	let parsed: ScopeBinding | null;
	try {
		parsed = validateScopeBindingPayload(
			directory,
			JSON.parse(raw) as Partial<ScopeBinding>,
		);
	} catch {
		return null;
	}
	if (!parsed) return null;
	if (hasScopeBindingDenyOverlay(parsed)) return null;
	const now = Date.now();
	if (
		parsed.source !== 'pr_feedback' ||
		(taskId !== undefined && parsed.taskId !== taskId) ||
		parsed.ownerSessionId !== activeSessionId ||
		parsed.activation !== 'active' ||
		typeof parsed.dispatchCallId !== 'string' ||
		!parsed.dispatchCallId ||
		parsed.ownerMessageId !== parsed.dispatchCallId ||
		typeof parsed.parentOwnerSessionId !== 'string' ||
		!parsed.parentOwnerSessionId ||
		parsed.ownerSessionId === parsed.parentOwnerSessionId ||
		parsed.parentCallId !== parsed.dispatchCallId ||
		parsed.workflowSessionId !== parsed.parentOwnerSessionId ||
		typeof parsed.workflowRevisionDigest !== 'string' ||
		!parsed.workflowRevisionDigest ||
		parsed.planId !== `pr-feedback:${parsed.workflowSessionId}` ||
		parsed.planStructureHash !== parsed.workflowRevisionDigest ||
		parsed.declaredAt > now ||
		parsed.expiresAt <= now ||
		parsed.lifecycleState !== 'live'
	)
		return null;
	const expectedPath = getBindingFilePath(directory, parsed);
	if (
		normalizePathForComparison(expectedPath) !==
		normalizePathForComparison(filePath)
	)
		return null;
	return parsed;
}

/** Recover one exact planless PR_FEEDBACK child binding after plugin restart. */
export function resolveAuthorizedPrFeedbackScopeBindingFromDisk(input: {
	directory: string;
	activeSessionId: string;
	taskId?: string;
}): ScopeBinding | null {
	if (!input.activeSessionId.trim()) return null;
	const scopesDir = getScopesDir(input.directory);
	if (!isScopesDirSafe(input.directory, scopesDir)) return null;
	if (!migrateLegacyBindingsSync(input.directory)) return null;
	let candidates: string[];
	if (input.taskId) {
		if (!isSafeTaskId(input.taskId)) return null;
		try {
			const names = fs.readdirSync(scopesDir);
			if (names.length > MAX_BINDING_FILES_TO_SCAN) return null;
			candidates = names
				.filter(
					(name) =>
						name.startsWith(exactBindingPrefix(input.taskId!)) &&
						name.endsWith('.json'),
				)
				.map((name) => path.join(scopesDir, name));
		} catch {
			return null;
		}
	} else {
		try {
			const names = fs.readdirSync(scopesDir);
			if (names.length > MAX_BINDING_FILES_TO_SCAN) return null;
			candidates = names
				.filter((name) => name.startsWith('binding-') && name.endsWith('.json'))
				.map((name) => path.join(scopesDir, name));
		} catch {
			return null;
		}
	}
	const matches = candidates
		.map((candidate) =>
			readPrFeedbackBindingFile(
				input.directory,
				candidate,
				input.activeSessionId,
				input.taskId,
			),
		)
		.filter((binding): binding is ScopeBinding => binding !== null);
	if (matches.length !== 1) return null;
	const admission = registerScopeBinding(matches[0]);
	return admission.ok ? matches[0] : null;
}

/**
 * Atomic write via temp + rename. Same pattern as src/gate-evidence.ts:105
 * but scoped to this module so it can live without a cross-dir dependency.
 */
async function atomicWrite(targetPath: string, content: string): Promise<void> {
	const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		await bunWrite(tempPath, content);
		fs.renameSync(tempPath, targetPath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			/* renamed or never created */
		}
	}
}

function atomicWriteSync(targetPath: string, content: string): void {
	const tempPath = `${targetPath}.tmp.${Date.now()}.${Math.floor(Math.random() * 1e9)}`;
	try {
		fs.writeFileSync(tempPath, content, { flag: 'wx' });
		fs.renameSync(tempPath, targetPath);
	} finally {
		try {
			fs.unlinkSync(tempPath);
		} catch {
			/* renamed or never created */
		}
	}
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
