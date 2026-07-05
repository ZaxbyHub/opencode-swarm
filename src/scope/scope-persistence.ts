/**
 * Scope persistence for #519 (v6.71.1 hotfix).
 *
 * Persists declared coder scope to `.swarm/scopes/scope-{taskId}.json` so that
 * scope survives cross-process delegation — in-memory `session.declaredCoderScope`
 * is lost when a coder session starts in a separate process (#496 root cause B).
 *
 * Also exposes a fallback reader that reads `plan.json:phases[].tasks[].files_touched`
 * for the active task, so architect-authored plans become a durable scope source
 * even when `declare_scope` was never called (#496 root cause C mitigation).
 *
 * Read/write contract:
 *   - Atomic write via temp + rename (POSIX atomic on same filesystem).
 *   - File lock via proper-lockfile while writing.
 *   - Schema versioning: readers fail closed on unknown version.
 *   - TTL: default 24h from declaredAt; expired scopes return null.
 *   - Symlink guards (defence in depth):
 *       * realpath containment check on `.swarm/scopes/` (closes parent-dir attack)
 *       * O_NOFOLLOW on both write-create and read-fd (closes leaf-file TOCTOU)
 *       * taskId-in-file must match the filename (closes cross-pollination)
 *       * declaredAt must be <= now (closes future-timestamp attack)
 *       * files array capped at MAX_FILES_PER_SCOPE (DoS cap)
 *       * plan.json size capped at MAX_PLAN_BYTES (DoS cap)
 *       * Windows reserved device names rejected (CON, NUL, LPT1, …)
 *
 * RESIDUAL RISKS — explicitly accepted (#520 tracks full syscall-layer remediation):
 *   1. Bash / interpreter writes bypass the tool-layer authority check. This
 *      module does not protect against a coder process running `sed -i`,
 *      `echo >`, `python -c`, etc. Mitigation is prompt-only (see coder.ts
 *      WRITE BLOCKED PROTOCOL) until #520 lands.
 *   2. Platform-portability of symlink guards:
 *        - realpath resolves POSIX symlinks and Windows junctions, but the
 *          Windows behaviour is not covered by CI (Linux-only test matrix).
 *        - O_NOFOLLOW is a no-op on Windows (falls back to 0). The realpath
 *          containment check on `.swarm/scopes/` remains the primary guard
 *          on that platform; leaf-file TOCTOU on Windows is not closed.
 *   3. Stale lockfile DoS: a crashed writer leaves a lock for up to
 *      LOCK_STALE_MS (30s). During that window, concurrent `declare_scope`
 *      calls fail silently and the architect relies on in-memory state.
 *      Acceptable because in-memory state remains authoritative inside the
 *      live process; disk is a fallback.
 *   4. Temp-file leak: a crash between `Bun.write(tmp)` and `renameSync`
 *      leaves `scope-{id}.json.tmp.{ts}.{rand}` files. No sweeper runs today;
 *      accumulation is bounded by `/swarm close` (which rm -rf's .swarm/scopes/).
 *
 * NOT a standalone security boundary. Tool-layer write interception is now
 * implemented in shell-write-detect.ts (Phases 1-2). This module closes the
 * cross-process gap and the plan-as-scope gap. The syscall-layer fix (#520)
 * remains the durable long-term boundary.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { bunWrite } from '../utils/bun-compat';

const SCOPE_SCHEMA_VERSION = 1 as const;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const SCOPES_DIR = '.swarm/scopes';
const MAX_FILES_PER_SCOPE = 10_000;
const MAX_PLAN_BYTES = 10 * 1024 * 1024; // 10 MiB — plan.json size cap
const MAX_SCOPE_BYTES = 2 * 1024 * 1024; // 2 MiB — scope file size cap

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

function getScopesDir(directory: string): string {
	return path.join(directory, SCOPES_DIR);
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
		const resolvedScopes = fs.realpathSync(scopesDir);
		const rel = path.relative(resolvedWorkspace, resolvedScopes);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	} catch {
		return false;
	}
}

function getScopeFilePath(directory: string, taskId: string): string {
	if (!isSafeTaskId(taskId)) {
		throw new Error(`Invalid taskId for scope persistence: ${taskId}`);
	}
	return path.join(getScopesDir(directory), `scope-${taskId}.json`);
}

/**
 * Write declared scope to `.swarm/scopes/scope-{taskId}.json` atomically.
 * Safe to call concurrently — proper-lockfile serialises writers per-file.
 *
 * Silent on I/O failure: scope persistence is a defense-in-depth layer, not a
 * hard requirement. In-memory state remains authoritative for the live process.
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
		release = await lockfile.lock(scopePath, {
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
	if (typeof parsed.expiresAt !== 'number' || now > parsed.expiresAt) {
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
