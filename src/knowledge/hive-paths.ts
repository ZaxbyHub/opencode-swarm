/**
 * Centralized hive (cross-project) storage path resolution.
 *
 * Problem (issue #1847 §1): the platform-specific branch that derives the hive
 * data directory was duplicated across `src/hooks/knowledge-store.ts`
 * (`resolveHiveKnowledgePath`/`resolveHiveRejectedPath`/`resolveHiveEventsPath`)
 * and `src/hooks/knowledge-events.ts` (`resolveHiveEventsPath`). Each duplication
 * is a drift vector — the audit-event path and the store path could diverge.
 *
 * This module is the single source of truth for hive path resolution. Both
 * hooks re-export from here so the store, the rejected log, and the audit-event
 * log always share one directory.
 *
 * Subprocess contract (AGENTS.md invariant 3): this module performs NO
 * subprocess calls and holds NO module-level mutable state (invariant 8). It
 * reads `process.env.HOME`/`LOCALAPPDATA`/`XDG_DATA_HOME` live on each call so
 * tests can redirect the hive directory via `process.env.HOME` without a cache.
 *
 * It is NOT imported on the plugin-init path (invariant 1); hive writes happen
 * only on the `/swarm promote`/close/curate/postmortem lazy paths, never on
 * `server()` resolution.
 */

import * as path from 'node:path';
import * as os from 'node:os';

/**
 * Resolve the platform-specific hive data directory (the directory that holds
 * `shared-learnings.jsonl`, `shared-learnings-rejected.jsonl`, and
 * `shared-knowledge-events.jsonl`). Reads `process.env.HOME` live each call —
 * Bun caches `os.homedir()`, so changing `$HOME` after the first cached call
 * is only observed by reading the env var first.
 */
export function resolveHiveDataDir(): string {
	const platform = process.platform;
	const home = process.env.HOME || os.homedir();
	if (platform === 'win32') {
		return path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'Data',
		);
	}
	if (platform === 'darwin') {
		return path.join(home, 'Library', 'Application Support', 'opencode-swarm');
	}
	return path.join(
		process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
		'opencode-swarm',
	);
}

/** Path to the hive knowledge store (`shared-learnings.jsonl`). */
export function resolveHiveKnowledgePath(): string {
	return path.join(resolveHiveDataDir(), 'shared-learnings.jsonl');
}

/** Path to the hive rejected-lessons log (`shared-learnings-rejected.jsonl`). */
export function resolveHiveRejectedPath(): string {
	return path.join(resolveHiveDataDir(), 'shared-learnings-rejected.jsonl');
}

/**
 * Path to the shared, cross-project hive knowledge-events log
 * (`shared-knowledge-events.jsonl`). Lives alongside the hive store so the
 * store and its audit history share one scope and one directory lock.
 */
export function resolveHiveEventsPath(): string {
	return path.join(resolveHiveDataDir(), 'shared-knowledge-events.jsonl');
}

/**
 * Test-only DI seam (AGENTS.md invariant 7). Tests redirect the hive directory
 * by overriding `resolveHiveDataDir` here rather than `mock.module`-ing each
 * consumer, which leaks across test files in Bun's shared runner.
 */
export const _internals = {
	resolveHiveDataDir,
	resolveHiveKnowledgePath,
	resolveHiveRejectedPath,
	resolveHiveEventsPath,
};
