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
		'--untracked-files=all',
	]);
	return {
		directory: path.resolve(directory),
		gitHead,
		dirtyHash: porcelain === null ? null : digest(porcelain),
		prHeadSha,
		scope,
	};
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
