import * as child_process from 'node:child_process';
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { BackgroundWorkspaceSnapshot } from './pending-delegations.js';

const GIT_SNAPSHOT_TIMEOUT_MS = 3_000;
const GIT_SNAPSHOT_MAX_BUFFER = 512 * 1024;

type SpawnSync = typeof child_process.spawnSync;

interface CaptureWorkspaceSnapshotOptions {
	scope?: string | null;
	prHeadSha?: string | null;
	/**
	 * Re-resolve the current upstream ref for freshness validation. When the
	 * dispatch captured an explicit PR head SHA, ingestion must compare against a
	 * live local ref, not replay the stored metadata back into the snapshot.
	 */
	resolveCurrentPrHeadSha?: boolean;
}

function runGit(directory: string, args: string[]): string | null {
	const result = _internals.spawnSync('git', ['-C', directory, ...args], {
		cwd: directory,
		encoding: 'utf-8',
		timeout: GIT_SNAPSHOT_TIMEOUT_MS,
		maxBuffer: GIT_SNAPSHOT_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.error || result.status !== 0) return null;
	return typeof result.stdout === 'string' ? result.stdout.trimEnd() : null;
}

function parseNulPaths(output: string): string[] {
	return output.split('\0').filter((entry) => entry.length > 0);
}

/** Parse `git status --porcelain=v1 -z`, including both sides of renames. */
export function parsePorcelainPaths(output: string): string[] | null {
	const entries = parseNulPaths(output);
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		if (entry.length < 4 || entry[2] !== ' ') return null;
		const status = entry.slice(0, 2);
		const changedPath = entry.slice(3);
		if (!changedPath) return null;
		paths.push(changedPath);
		if (status.includes('R') || status.includes('C')) {
			const originalPath = entries[++index];
			if (!originalPath) return null;
			paths.push(originalPath);
		}
	}
	return [...new Set(paths)];
}

export function captureWorkspaceSnapshot(
	directory: string,
	optionsOrScope: string | null | CaptureWorkspaceSnapshotOptions = null,
	prHeadShaArg: string | null = null,
): BackgroundWorkspaceSnapshot {
	const scope =
		typeof optionsOrScope === 'object' && optionsOrScope !== null
			? (optionsOrScope.scope ?? null)
			: optionsOrScope;
	const prHeadSha = (() => {
		if (typeof optionsOrScope !== 'object' || optionsOrScope === null) {
			return prHeadShaArg;
		}
		if (optionsOrScope.resolveCurrentPrHeadSha) {
			return runGit(directory, ['rev-parse', '@{upstream}']);
		}
		return optionsOrScope.prHeadSha ?? null;
	})();
	const gitHead = runGit(directory, ['rev-parse', 'HEAD']);
	const porcelain = runGit(directory, [
		'status',
		'--porcelain=v1',
		'-z',
		'--untracked-files=all',
	]);
	const changedFiles =
		porcelain === null ? null : parsePorcelainPaths(porcelain);
	return {
		directory: path.resolve(directory),
		gitHead,
		dirtyHash: porcelain === null ? null : digest(porcelain),
		changedFiles,
		prHeadSha,
		scope,
	};
}

/**
 * Conservatively derive final paths changed since a pre-task snapshot.
 * Git or parsing failures return null so gate classification fails closed.
 */
export function changedFilesSinceSnapshot(
	directory: string,
	baseline: BackgroundWorkspaceSnapshot | undefined,
): string[] | null {
	if (!baseline?.gitHead || baseline.changedFiles == null) return null;
	// A dirty baseline cannot prove which same-path edits belong to this task.
	// Fail closed instead of treating unchanged pre-existing dirt as task output.
	if (baseline.changedFiles.length > 0) return null;
	const current = captureWorkspaceSnapshot(directory);
	if (!current.gitHead || current.changedFiles == null) return null;

	const changed = new Set(current.changedFiles);
	if (baseline.gitHead !== current.gitHead) {
		const committed = runGit(directory, [
			'diff',
			'--name-only',
			'-z',
			baseline.gitHead,
			current.gitHead,
		]);
		if (committed === null) return null;
		for (const changedPath of parseNulPaths(committed))
			changed.add(changedPath);
	}

	return [...changed];
}

export function workspaceSnapshotMatches(
	expected: BackgroundWorkspaceSnapshot | undefined,
	current: BackgroundWorkspaceSnapshot,
): { ok: true } | { ok: false; reason: string } {
	if (!expected) return { ok: true };
	if (path.resolve(expected.directory) !== path.resolve(current.directory)) {
		return {
			ok: false,
			reason: `directory changed: expected ${expected.directory}, got ${current.directory}`,
		};
	}
	const checks: Array<
		keyof Pick<
			BackgroundWorkspaceSnapshot,
			'gitHead' | 'dirtyHash' | 'prHeadSha'
		>
	> = ['gitHead', 'dirtyHash', 'prHeadSha'];
	for (const key of checks) {
		const expectedValue = expected[key];
		if (expectedValue === null) continue;
		if (current[key] !== expectedValue) {
			return {
				ok: false,
				reason: `${key} changed: expected ${expectedValue}, got ${current[key] ?? 'unknown'}`,
			};
		}
	}
	return { ok: true };
}

export type WorkspaceFreshness = ReturnType<typeof workspaceSnapshotMatches>;

export const compareWorkspaceSnapshot = workspaceSnapshotMatches;

export function compareWorkspaceSnapshots(
	expected: BackgroundWorkspaceSnapshot | undefined,
	current: BackgroundWorkspaceSnapshot,
): { stale: boolean; reason?: string } {
	const result = workspaceSnapshotMatches(expected, current);
	if (result.ok) return { stale: false };
	return { stale: true, reason: result.reason };
}

export function digest(text: string): string {
	return createHash('sha256').update(text).digest('hex');
}

export const _internals: { spawnSync: SpawnSync } = {
	spawnSync: child_process.spawnSync,
};
