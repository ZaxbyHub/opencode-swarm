/**
 * One global, cross-process transaction primitive for hive storage (issue #1847 §1).
 *
 * Problem: hive promotion previously performed read → N× append → batch rewrite
 * → cap enforcement as FOUR separate directory-lock acquisitions, with unlocked
 * read/validate/dedup windows between them. Because the hive store
 * (`shared-learnings.jsonl`) is a shared, cross-project, cross-process file,
 * two opencode-swarm sessions could each read the same snapshot and one's
 * rewrite silently dropped the other's entries (TOCTOU lost update — #1604).
 *
 * This module routes every hive writer through ONE critical section that spans,
 * under a single directory lock:
 *   1. read + mixed-schema normalize;
 *   2. the caller's mutate (eligibility, canonical project counting, dedup,
 *      merge decision, append/update, source confirmation);
 *   3. validate-before-commit;
 *   4. priority-aware cap enforcement (in the same closure, not a separate call);
 *   5. staged audit/reject appends (raw, under the held lock — never via
 *      `appendHiveKnowledgeEvent`, which would re-enter the directory lock and
 *      deadlock — see the curator precedent at `curator.ts:1966-1969`);
 *   6. atomic persistence (temp + rename).
 *
 * Lock contract (AGENTS.md invariants 3, 8): `stale: 5000` to MATCH every other
 * hive writer (`appendKnowledge`, `rewriteKnowledge`, `transactKnowledge`,
 * `knowledge-application.ts`, `knowledge-escalator.ts`). proper-lockfile's stale
 * mechanism is preemptive — a process that cannot acquire the lock and sees its
 * mtime older than its OWN stale threshold force-breaks it. Using a longer stale
 * here would let a concurrent 5s writer break this transaction mid-flight and
 * tear the file, which is exactly the bug this PR fixes. The held closure is
 * kept fast (in-memory mutate + one atomic write + raw appends) so 5s is never
 * exceeded; all heavy work (git cohort resolution, evidence rollup, near-
 * duplicate precompute) runs OUTSIDE the lock and is passed in via HiveTxContext.
 *
 * This module holds NO module-level mutable state (invariant 8) and is NOT
 * imported on the plugin-init path (invariant 1).
 */

import { appendFile, mkdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../evidence/task-file.js';
import {
	resolveHiveDataDir,
	resolveHiveEventsPath,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
} from '../knowledge/hive-paths.js';
import { warn } from '../utils/logger.js';
import { MAX_EVENT_LOG_ENTRIES } from './knowledge-events.js';
import {
	readKnowledge,
	selectKnowledgeCapSurvivors,
} from './knowledge-store.js';
import type { HiveKnowledgeEntry, RejectedLesson } from './knowledge-types.js';

/** Stale duration MUST match every other hive writer (see module docstring). */
const HIVE_LOCK_STALE_MS = 5_000;
const HIVE_LOCK_RETRIES = {
	retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
} as const;

/**
 * Context handed to a hive mutation closure. All expensive pre-work (cohort
 * resolution, evidence loading, near-duplicate indexing) is performed by the
 * caller OUTSIDE the lock and injected here so the held closure stays fast.
 */
export interface HiveTxContext {
	/** Current hive entries (read + normalized under the lock). */
	entries: HiveKnowledgeEntry[];
}

/** A pre-serialized knowledge-event line to append to the hive audit log. */
export interface HiveAuditEntry {
	line: string;
}

/**
 * A staged raw append to a JSONL file inside the hive data dir, performed under the
 * held directory lock AFTER the atomic store write (issue #2033). Used by the
 * human-only hive-quarantine flow to append quarantine records to the
 * `shared-learnings-quarantined.jsonl` sidecar with the same atomicity guarantees as
 * the audit log — never via `appendKnowledge`, which would re-enter the lock.
 */
export interface HiveStagedAppend {
	/** Absolute path of an existing-or-new .jsonl file inside the hive data dir. */
	path: string;
	/** Pre-serialized JSONL block (newline-terminated lines). */
	block: string;
}

/**
 * Thrown when a staged append fails AFTER the atomic store rewrite (issue #2033). The
 * store mutation already happened, so callers must compensate (the hive-quarantine flow
 * restores from its just-written backup) rather than treating this as a clean abort.
 */
export class HiveStagedAppendError extends Error {
	constructor(
		public readonly stagedPath: string,
		public readonly cause: unknown,
	) {
		super(
			`staged append failed after store rewrite (${stagedPath}): ${
				cause instanceof Error ? cause.message : String(cause)
			}`,
		);
		this.name = 'HiveStagedAppendError';
	}
}

/** The result a mutation closure returns. */
export type HiveMutationOutcome<T> =
	| {
			kind: 'commit';
			entries: HiveKnowledgeEntry[];
			/** Hive cap to enforce inside the same closure (omit for no cap). */
			maxEntries?: number;
			/** Rejected lessons to append to the hive rejected log under the lock. */
			rejects?: RejectedLesson[];
			/** Audit lines to append to the hive events log under the lock. */
			audit?: HiveAuditEntry[];
			/**
			 * Additional staged raw JSONL appends under the same lock (issue #2033).
			 * Each path is validated (before the atomic write) to resolve inside the
			 * hive data dir, end in `.jsonl`, and NOT sit under `quarantine-backups/`
			 * (reparse/junction defense). These appends are NEVER FIFO-trimmed.
			 */
			extraStagedAppends?: HiveStagedAppend[];
			/**
			 * Exact raw line bytes to persist for specific entry ids (issue #2033),
			 * overriding the `JSON.stringify(entry)` serialization. Used by the
			 * hive-quarantine rollback so restored legacy-shaped entries are written
			 * byte-exactly instead of re-serialized through the normalize-on-read
			 * pipeline. A Map by contract (PR review CC-9): plain-object maps
			 * silently corrupt prototype-key ids like '__proto__'.
			 */
			rawLineOverrides?: ReadonlyMap<string, string>;
			/** Caller return value surfaced back through HiveTransactionResult. */
			return: T;
	  }
	| { kind: 'noop'; return: T };

export interface HiveTransactionResult<T> {
	/** True iff the hive file was rewritten within the transaction. */
	committed: boolean;
	/**
	 * The caller's return value. Present when `committed` is true OR the mutate
	 * closure returned a `noop` outcome. Undefined on lock-acquire / mkdir /
	 * validation-before-commit failure (F-004/PRR-1): callers MUST check
	 * `committed` (or `return !== undefined`) before dereferencing it.
	 */
	return: T | undefined;
	/** Human-readable diagnostics (lock timeout, validation failure, etc.). */
	diagnostics: string[];
}

/**
 * Run `mutate` against the hive store inside one cross-process transaction.
 *
 * On lock-acquire failure or validation failure the prior hive file is left
 * intact (the atomic write is not performed) and `committed` is false; the
 * function never hangs. `mutate` receives the current (normalized) entries and
 * returns either a `commit` (new entries + optional cap/rejects/audit) or a
 * `noop`.
 */
export async function transactHiveStore<T>(
	mutate: (
		ctx: HiveTxContext,
	) => Promise<HiveMutationOutcome<T>> | HiveMutationOutcome<T>,
): Promise<HiveTransactionResult<T>> {
	const dataDir = _internals.resolveHiveDataDir();
	const hivePath = _internals.resolveHiveKnowledgePath();
	const rejectedPath = _internals.resolveHiveRejectedPath();
	const eventsPath = _internals.resolveHiveEventsPath();

	const diagnostics: string[] = [];

	try {
		await mkdir(dataDir, { recursive: true });
	} catch (err) {
		diagnostics.push(
			`hive data dir create failed: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		return { committed: false, return: undefined, diagnostics };
	}

	let release: (() => Promise<void>) | null = null;
	try {
		try {
			release = await _internals.lockfile.lock(dataDir, {
				...HIVE_LOCK_RETRIES,
				stale: HIVE_LOCK_STALE_MS,
			});
		} catch (err) {
			// Fail safe: do NOT hang. The caller (promotion) is fire-and-forget
			// via safeHook; a transient lock failure surfaces as a non-fatal warning.
			diagnostics.push(
				`hive lock acquire failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return { committed: false, return: undefined, diagnostics };
		}

		// 1. Read + normalize under the lock.
		const entries =
			await _internals.readKnowledge<HiveKnowledgeEntry>(hivePath);

		// 2. Caller mutation.
		const outcome = await mutate({ entries });

		if (outcome.kind === 'noop') {
			return { committed: false, return: outcome.return, diagnostics };
		}

		// 3. Validate-before-commit: every entry must serialize and have a string
		//    id + non-empty lesson. On failure the prior file is left intact.
		let committedEntries = outcome.entries;
		try {
			for (const entry of committedEntries) {
				JSON.stringify(entry);
				if (typeof entry.id !== 'string' || entry.id.length === 0) {
					throw new Error('entry missing string id');
				}
				if (typeof entry.lesson !== 'string' || entry.lesson.length === 0) {
					throw new Error('entry missing non-empty lesson');
				}
			}
		} catch (err) {
			diagnostics.push(
				`hive validation failed; aborting before commit: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			// PRR-3: do NOT surface outcome.return — it carries counts computed
			// from the rejected entries that were never persisted. Returning
			// undefined forces callers through the !committed branch so they
			// report zero activity + the diagnostic reason.
			return { committed: false, return: undefined, diagnostics };
		}

		// 4. Priority-aware cap enforcement in the SAME closure (not a separate
		//    transactKnowledge call that would re-acquire the lock).
		if (
			typeof outcome.maxEntries === 'number' &&
			committedEntries.length > outcome.maxEntries
		) {
			committedEntries = _internals.selectKnowledgeCapSurvivors(
				committedEntries,
				outcome.maxEntries,
			);
		}

		// 4b. Pre-write validation of staged-append targets (issue #2033): purely lexical,
		//     so a bad path can NEVER reach this point after the store has been rewritten.
		if (outcome.extraStagedAppends && outcome.extraStagedAppends.length > 0) {
			for (const staged of outcome.extraStagedAppends) {
				await validateStagedAppendPath(staged.path, dataDir);
			}
		}

		// 5. Atomic persistence: temp + rename. On crash the previous file is
		//    intact (rename is atomic; the temp is orphaned but cleaned by
		//    atomicWriteFile's finally). `rawLineOverrides` (issue #2033) lets a
		//    caller demand EXACT original line bytes for specific ids — used by the
		//    hive-quarantine rollback so restored legacy-shaped entries are not
		//    re-serialized through the normalize-on-read pipeline.
		const overrides = outcome.rawLineOverrides;
		const content =
			committedEntries
				.map((e) => overrides?.get(e.id) ?? JSON.stringify(e))
				.join('\n') + (committedEntries.length > 0 ? '\n' : '');
		await _internals.atomicWriteFile(hivePath, content);

		// 6. Staged appends (rejects + audit) under the SAME lock, via raw
		// appendFile. NEVER via appendKnowledge/appendHiveKnowledgeEvent,
		// which would re-enter the directory lock and deadlock. (See curator
		// precedent at curator.ts:1966-1969.)
		if (outcome.rejects && outcome.rejects.length > 0) {
			const rejectBlock = `${outcome.rejects.map((r) => JSON.stringify(r)).join('\n')}\n`;
			await appendFile(rejectedPath, rejectBlock, 'utf-8');
		}
		if (outcome.audit && outcome.audit.length > 0) {
			const auditBlock = `${outcome.audit.map((a) => a.line).join('\n')}\n`;
			await appendFile(eventsPath, auditBlock, 'utf-8');
			// FIFO trim the events log to the cap under the same lock (audit-only;
			// hive events do not participate in the counter rollup baseline).
			try {
				await trimHiveEventsUnderLock(eventsPath);
			} catch (err) {
				warn(
					`[hive-transaction] hive events cap trim failed (non-fatal): ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		}

		// 6b. Extra staged appends (issue #2033): validated sibling JSONL writes under
		// the same held lock. Never FIFO-trimmed — quarantine sidecars are operator
		// records and must not be silently evicted. An I/O failure here happens AFTER
		// the store rewrite, so it throws a typed HiveStagedAppendError letting the
		// caller run its own backup-restore compensation instead of seeing a raw,
		// post-mutation failure with no recovery (reviewer finding 3).
		if (outcome.extraStagedAppends && outcome.extraStagedAppends.length > 0) {
			for (const staged of outcome.extraStagedAppends) {
				try {
					await _internals.appendFile(staged.path, staged.block, 'utf-8');
				} catch (err) {
					throw new HiveStagedAppendError(staged.path, err);
				}
			}
		}

		return { committed: true, return: outcome.return, diagnostics };
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				/* lock release failed — non-blocking */
			}
		}
	}
}

/**
 * Validate a staged-append target (issue #2033): absolute, inside the hive data dir,
 * `.jsonl` extension, and NOT under `quarantine-backups/`. Lexical resolution plus a
 * `..`-segment rejection guards path escapes; the data-dir prefix guard makes symlink
 * targets inside the backups tree unreachable as staging destinations.
 */
async function validateStagedAppendPath(
	target: string,
	dataDir: string,
): Promise<void> {
	if (!path.isAbsolute(target)) {
		throw new Error(`staged append path must be absolute: ${target}`);
	}
	if (path.extname(target) !== '.jsonl') {
		throw new Error(`staged append path must end in .jsonl: ${target}`);
	}
	const resolvedDir = path.resolve(path.dirname(target));
	const resolvedDataDir = path.resolve(dataDir);
	const normalizedDir =
		process.platform === 'win32' ? resolvedDir.toLowerCase() : resolvedDir;
	const normalizedDataDir =
		process.platform === 'win32'
			? resolvedDataDir.toLowerCase()
			: resolvedDataDir;
	const insideDataDir =
		normalizedDir === normalizedDataDir ||
		normalizedDir.startsWith(`${normalizedDataDir}${path.sep}`);
	if (!insideDataDir) {
		throw new Error(
			`staged append path escapes the hive data dir: ${target} (data dir ${dataDir})`,
		);
	}
	if (normalizedDir.includes(`${path.sep}quarantine-backups${path.sep}`)) {
		throw new Error(
			`staged append path must not target quarantine backups: ${target}`,
		);
	}
	// Reparse/symlink defense (PR review CC-4): lexical prefix compares never
	// detect a symlinked path segment — resolve both sides and require the
	// staged target's directory to sit inside the RESOLVED data dir.
	const realDir = await realpathQuiet(path.dirname(target));
	const realDataDir = await realpathQuiet(dataDir);
	const foldReal = (q: string) =>
		process.platform === 'win32' ? q.toLowerCase() : q;
	const foldedDir = realDir === null ? '' : foldReal(realDir);
	const foldedData = realDataDir === null ? '' : foldReal(realDataDir);
	if (
		realDir === null ||
		realDataDir === null ||
		(foldedDir !== foldedData &&
			!foldedDir.startsWith(`${foldedData}${path.sep}`))
	) {
		throw new Error(
			`staged append path resolves outside the hive data dir: ${target}`,
		);
	}
}

/** Resolve a path, returning null instead of throwing when unreachable. */
async function realpathQuiet(target: string): Promise<string | null> {
	try {
		return await realpath(target);
	} catch {
		return null;
	}
}

/**
 * FIFO-trim the hive events log to MAX_EVENT_LOG_ENTRIES. Runs under the
 * already-held directory lock (called only from transactHiveStore). Reads +
 * rewrites via atomicWriteFile so readers never see a torn file.
 */
async function trimHiveEventsUnderLock(eventsPath: string): Promise<void> {
	const { readFile } = await import('node:fs/promises');
	const { existsSync } = await import('node:fs');
	if (!existsSync(eventsPath)) return;
	const content = await readFile(eventsPath, 'utf-8');
	const lines = content.split('\n').filter((l) => l.trim().length > 0);
	if (lines.length <= MAX_EVENT_LOG_ENTRIES) return;
	const trimmed = lines.slice(lines.length - MAX_EVENT_LOG_ENTRIES);
	await atomicWriteFile(eventsPath, `${trimmed.join('\n')}\n`);
}

/** Path to the hive events log (re-exported for callers building audit lines). */
export { resolveHiveEventsPath };
export const HIVE_TXN_LOCK_STALE_MS = HIVE_LOCK_STALE_MS;

/**
 * Test-only DI seam (AGENTS.md invariant 7). Tests inject a fake lockfile /
 * readers / writers rather than `mock.module`-ing the consumers, which leaks
 * across test files in Bun's shared runner.
 */
export const _internals = {
	lockfile,
	readKnowledge,
	atomicWriteFile,
	selectKnowledgeCapSurvivors,
	resolveHiveDataDir,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveHiveEventsPath,
	// staged-append seam (issue #2033): tests inject failures AFTER the atomic store
	// write to prove the caller's compensation path (HiveStagedAppendError).
	appendFile,
	// re-exported for tests that build expected paths
	path,
};
