import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
	_internals,
	resolveCommitCountSince,
	resolveCurrentUpstreamPushTarget,
	resolveCurrentUpstreamRemoteRef,
	resolveExactMergeBase,
	resolveExactRemoteBranchHead,
	resolveGitControlStateDigest,
	resolveIsExactSingleChildCommit,
	resolveIsWorkingTreeClean,
	resolvePrReviewDiffStats,
	resolveRemoteRefsContainingHead,
} from '../../../src/background/workspace-snapshot.js';

const originalSpawnSync = _internals.spawnSync;

afterEach(() => {
	_internals.spawnSync = originalSpawnSync;
});

describe('PR workflow Git publication observations', () => {
	test('resolves only the exact merge base for safe base and head revisions', () => {
		const spawn = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('merge-base') ? 'def456\n' : '',
			stderr: '',
		}));
		_internals.spawnSync = spawn as typeof _internals.spawnSync;

		expect(resolveExactMergeBase('.', 'origin/main', 'abc123')).toBe('def456');
		expect(resolveExactMergeBase('.', '--all', 'abc123')).toBeNull();
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	test('diff stats sum numstat lines and files for the exact bound range', () => {
		const spawn = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('--numstat')
				? '10\t2\tsrc/a.ts\n3\t0\tsrc/b.ts\n-\t-\tassets/logo.png\n'
				: '',
			stderr: '',
		}));
		_internals.spawnSync = spawn as typeof _internals.spawnSync;

		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toEqual({
			changedLines: 15,
			changedFiles: 3,
			hasSubmoduleChange: false,
		});
		// Rename detection is pinned off so results do not depend on the
		// executing machine's ambient git config/version.
		expect(spawn.mock.calls[0][1]).toContain('--no-renames');
		// Unsafe revision tokens never reach Git.
		expect(resolvePrReviewDiffStats('.', '--all', 'abc123')).toBeNull();
		// Exactly one numstat call plus one raw (gitlink-detection) call for the
		// single valid invocation above; the unsafe-token invocation never
		// reaches Git at all.
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	test('diff stats detect a submodule (gitlink) pointer change from the raw diff', () => {
		const spawn = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('--numstat')
				? '1\t1\tvendor/sub\n'
				: args.includes('--raw')
					? ':100644 160000 aaaaaaa bbbbbbb M\tvendor/sub\n'
					: '',
			stderr: '',
		}));
		_internals.spawnSync = spawn as typeof _internals.spawnSync;

		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toEqual({
			changedLines: 2,
			changedFiles: 1,
			hasSubmoduleChange: true,
		});
	});

	test('diff stats fail strict to null when the raw gitlink-detection call fails', () => {
		const spawn = mock((_command, args) => ({
			status: args.includes('--raw') ? 1 : 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('--numstat') ? '1\t1\tsrc/a.ts\n' : '',
			stderr: '',
		}));
		_internals.spawnSync = spawn as typeof _internals.spawnSync;

		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toBeNull();
	});

	test('diff stats fail strict to null on git failure or malformed numstat', () => {
		_internals.spawnSync = mock(() => ({
			status: 1,
			signal: null,
			pid: 1,
			output: [],
			stdout: '',
			stderr: 'fatal: bad revision',
		})) as typeof _internals.spawnSync;
		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toBeNull();

		_internals.spawnSync = mock(() => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: 'not-a-numstat-row\n',
			stderr: '',
		})) as typeof _internals.spawnSync;
		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toBeNull();
	});

	test('diff stats fail strict to null on a spawn/buffer-overflow error', () => {
		_internals.spawnSync = mock(() => ({
			status: null,
			signal: null,
			pid: 1,
			output: [],
			stdout: '',
			stderr: '',
			error: new Error('spawnSync git ENOBUFS'),
		})) as typeof _internals.spawnSync;
		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toBeNull();
	});

	test('diff stats return zero totals for an empty diff', () => {
		_internals.spawnSync = mock(() => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: '',
			stderr: '',
		})) as typeof _internals.spawnSync;
		expect(resolvePrReviewDiffStats('.', 'def456', 'abc123')).toEqual({
			changedLines: 0,
			changedFiles: 0,
			hasSubmoduleChange: false,
		});
	});

	test('publication proof accepts only a remote ref whose tip exactly equals HEAD', () => {
		_internals.spawnSync = mock(() => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout:
				'refs/remotes/origin/pr\tabc123\nrefs/remotes/origin/descendant\tdef456\nrefs/remotes/origin/HEAD\tabc123',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveRemoteRefsContainingHead('.', 'abc123')).toEqual([
			'refs/remotes/origin/pr',
		]);
	});

	test('commit proof uses the exact ancestry path from intake to current HEAD', () => {
		_internals.spawnSync = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout:
				args.includes('--ancestry-path') && args.includes('base..current')
					? '1\n'
					: '',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveCommitCountSince('.', 'base', 'current')).toBe(1);
	});

	test('clean proof includes tracked, staged, and untracked worktree state', () => {
		_internals.spawnSync = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('--untracked-files=all') ? '' : 'unexpected',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveIsWorkingTreeClean('.')).toBe(true);
	});

	test('commit shape accepts only one parent equal to the immutable intake head', () => {
		_internals.spawnSync = mock((_command, args) => {
			const joined = args.join(' ');
			const stdout = joined.includes('base^{commit}')
				? 'base-full\n'
				: joined.includes('current^{commit}')
					? 'current-full\n'
					: joined.includes('--parents')
						? 'current-full base-full\n'
						: '';
			return {
				status: 0,
				signal: null,
				pid: 1,
				output: [],
				stdout,
				stderr: '',
			};
		}) as typeof _internals.spawnSync;

		expect(resolveIsExactSingleChildCommit('.', 'base', 'current')).toBe(true);
	});

	test('commit shape rejects merge commits with a second parent', () => {
		_internals.spawnSync = mock((_command, args) => {
			const joined = args.join(' ');
			const stdout = joined.includes('base^{commit}')
				? 'base-full\n'
				: joined.includes('current^{commit}')
					? 'current-full\n'
					: joined.includes('--parents')
						? 'current-full base-full second-parent\n'
						: '';
			return {
				status: 0,
				signal: null,
				pid: 1,
				output: [],
				stdout,
				stderr: '',
			};
		}) as typeof _internals.spawnSync;

		expect(resolveIsExactSingleChildCommit('.', 'base', 'current')).toBe(false);
	});
});

describe('publication remote-ref binding', () => {
	test('resolves structured upstream names and refs without slash guessing', () => {
		_internals.spawnSync = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('symbolic-ref')
				? 'refs/heads/local\n'
				: 'team/remote\0refs/heads/feature/nested\0refs/remotes/team/remote/feature/nested\n',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveCurrentUpstreamPushTarget('.')).toEqual({
			remoteName: 'team/remote',
			remoteBranchRef: 'refs/heads/feature/nested',
			remoteTrackingRef: 'refs/remotes/team/remote/feature/nested',
		});
	});

	test('requires the actual remote branch to report one exact object id', () => {
		const oid = 'a'.repeat(40);
		_internals.spawnSync = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('ls-remote') ? `${oid}\trefs/heads/feature\n` : '',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(
			resolveExactRemoteBranchHead('.', 'origin', 'refs/heads/feature'),
		).toBe(oid);
		expect(
			resolveExactRemoteBranchHead('.', '-upload-pack=x', 'refs/heads/feature'),
		).toBeNull();
	});

	test('control-state digest binds HEAD, refs, config, and index', () => {
		_internals.spawnSync = mock((_command, args) => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: args.includes('rev-parse')
				? 'head\n'
				: args.includes('symbolic-ref')
					? 'refs/heads/pr\n'
					: args.some((arg) => arg.includes('%(upstream:remotename)'))
						? 'origin\0refs/heads/pr\0refs/remotes/origin/pr\n'
						: args.includes('for-each-ref')
							? 'refs/heads/pr\0head\n'
							: args.includes('config')
								? 'local\0file:.git/config\0key=value\0'
								: '100644 blob 0\tfile.ts\0',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveGitControlStateDigest('.')).toMatch(/^[0-9a-f]{64}$/);
	});

	test('accepts only an exact remote-tracking upstream ref', () => {
		_internals.spawnSync = mock(() => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: 'refs/remotes/origin/feature\n',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveCurrentUpstreamRemoteRef('.')).toBe(
			'refs/remotes/origin/feature',
		);
	});

	test('rejects a local branch as publication proof', () => {
		_internals.spawnSync = mock(() => ({
			status: 0,
			signal: null,
			pid: 1,
			output: [],
			stdout: 'refs/heads/feature\n',
			stderr: '',
		})) as typeof _internals.spawnSync;

		expect(resolveCurrentUpstreamRemoteRef('.')).toBeNull();
	});
});
