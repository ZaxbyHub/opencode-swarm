/**
 * #3427 feedback (PRR-011/FR-006): shared seam stubs for checkpoint suites.
 * The checkpoint tool's async repository probes are stubbed via the
 * `_internals` seams by property assignment (restored by the suite) — never
 * mock.module, whose process-global registration poisons co-run files.
 */
type CheckpointInternals = {
	readGitStatusAsync: (...args: unknown[]) => Promise<unknown>;
	readGitRepositoryStatusDetailedAsync: (
		...args: unknown[]
	) => Promise<unknown>;
};

/** Probe answers "is a git repository" — for real-git checkpoint suites. */
export function stubCheckpointProbesAsRepo(
	internals: CheckpointInternals,
): void {
	internals.readGitStatusAsync = (async () => ({
		ok: true as const,
		stdout: '.git\n',
	})) as unknown as CheckpointInternals['readGitStatusAsync'];
	internals.readGitRepositoryStatusDetailedAsync = (async () => ({
		isRepo: true,
	})) as unknown as CheckpointInternals['readGitRepositoryStatusDetailedAsync'];
}

/** Probe answers not_git_repo — for non-git-directory refusal legs. */
export function stubCheckpointPreflightNotRepo(
	internals: CheckpointInternals,
): void {
	internals.readGitRepositoryStatusDetailedAsync = (async () => ({
		isRepo: false as const,
		reason: 'not_git_repo' as const,
		message: 'fatal: not a git repository',
	})) as unknown as CheckpointInternals['readGitRepositoryStatusDetailedAsync'];
}
