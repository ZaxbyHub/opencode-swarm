import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	attemptMergeBackFromDirty,
	cleanupOrphanedBranches,
	type MergeOperationProvenance,
	_internals as mergeInternals,
} from '../../../src/worktree/merge';
import {
	_internals,
	preserveSettlementSource,
	probeSettlementSource,
	releaseSettlementSource,
	restoreSettlementBranch,
	settlementBackupRef,
	validateSettlementLane,
} from '../../../src/worktree/settlement-source-recovery';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];
function git(root: string, ...args: string[]): string {
	return execFileSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		timeout: 60000,
		maxBuffer: 65536,
		stdio: ['ignore', 'pipe', 'pipe'],
		// Stable git diagnostics so failure assertions can match exact stderr text.
		env: { ...process.env, LC_ALL: 'C' },
	}).trim();
}
function fixture() {
	const root = canonicalMkdtemp('settlement-source-3409-');
	roots.push(root);
	git(root, 'init', '--initial-branch=main');
	git(root, 'config', 'user.email', 'tests@example.invalid');
	git(root, 'config', 'user.name', 'Tests');
	git(root, 'config', 'core.autocrlf', 'false');
	fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
	git(root, 'add', '.');
	git(root, 'commit', '-m', 'base');
	const target = git(root, 'rev-parse', 'HEAD');
	const lane = path.join(root, '.swarm', 'worktrees', 'lane');
	fs.mkdirSync(path.dirname(lane), { recursive: true });
	const branch = 'swarm/lane/ref-test';
	git(root, 'worktree', 'add', '-b', branch, lane);
	fs.writeFileSync(path.join(lane, 'first.txt'), 'first\n');
	git(lane, 'add', '.');
	git(lane, 'commit', '-m', 'first');
	const first = git(lane, 'rev-parse', 'HEAD');
	fs.writeFileSync(path.join(lane, 'second.txt'), 'second\n');
	git(lane, 'add', '.');
	git(lane, 'commit', '-m', 'second');
	const source = git(lane, 'rev-parse', 'HEAD');
	const provenance: MergeOperationProvenance = {
		operationId: 'op',
		branchName: branch,
		sourceHead: source,
		targetHeadBefore: target,
		strategy: 'merge',
	};
	return { root, lane, branch, source, target, first, provenance };
}
const realSpawn = _internals.bunSpawn;
const realMergeSpawn = mergeInternals.bunSpawn;
afterEach(() => {
	_internals.bunSpawn = realSpawn;
	mergeInternals.bunSpawn = realMergeSpawn;
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
});
describe('settlement exact source retention #3409', () => {
	test('pins an orphan object outside lane cleanup namespace and releases idempotently', async () => {
		const { root, lane, branch, source } = fixture();
		git(root, 'worktree', 'remove', '--force', lane);
		git(root, 'branch', '-D', branch);
		expect(await probeSettlementSource(root, source)).toBe('present');
		const ref = await preserveSettlementSource(root, source);
		expect(ref).toBe(settlementBackupRef(source));
		expect(git(root, 'rev-parse', ref)).toBe(source);
		expect(await restoreSettlementBranch(root, branch, source)).toBe(true);
		expect(await restoreSettlementBranch(root, branch, source)).toBe(false);
		expect(git(root, 'rev-parse', '--verify', ref)).toBe(source);
		await releaseSettlementSource(root, source);
		await releaseSettlementSource(root, source);
		expect(() => git(root, 'rev-parse', '--verify', ref)).toThrow(
			/Needed a single revision/,
		);
	});
	test('foreign lane occupancy is preserved while backup retains exact source', async () => {
		const { root, lane, branch, source, target } = fixture();
		git(root, 'worktree', 'remove', '--force', lane);
		git(root, 'branch', '-f', branch, target);
		const ref = await preserveSettlementSource(root, source);
		await expect(restoreSettlementBranch(root, branch, source)).rejects.toThrow(
			'occupied ref',
		);
		expect(git(root, 'rev-parse', branch)).toBe(target);
		expect(git(root, 'rev-parse', ref)).toBe(source);
	});
	test('symbolic backup cannot overwrite or delete its foreign victim', async () => {
		const { root, source, target } = fixture();
		const ref = settlementBackupRef(source);
		git(root, 'update-ref', 'refs/heads/victim', target);
		git(root, 'symbolic-ref', ref, 'refs/heads/victim');
		await expect(preserveSettlementSource(root, source)).rejects.toThrow(
			'symbolic',
		);
		await expect(releaseSettlementSource(root, source)).rejects.toThrow(
			'symbolic',
		);
		expect(git(root, 'rev-parse', 'refs/heads/victim')).toBe(target);
	});
	test('symbolic lane refuses restoration and leaves victim untouched', async () => {
		const { root, lane, branch, source, target } = fixture();
		git(root, 'worktree', 'remove', '--force', lane);
		git(root, 'branch', '-D', branch);
		git(root, 'update-ref', 'refs/heads/victim', target);
		git(root, 'symbolic-ref', `refs/heads/${branch}`, 'refs/heads/victim');
		await expect(restoreSettlementBranch(root, branch, source)).rejects.toThrow(
			'symbolic',
		);
		expect(git(root, 'rev-parse', 'victim')).toBe(target);
	});
	test('missing full commit is absent while malformed and corrupt objects are uncertain', async () => {
		const { root, source } = fixture();
		expect(await probeSettlementSource(root, 'f'.repeat(40))).toBe('absent');
		await expect(probeSettlementSource(root, '--bad')).rejects.toThrow(
			'malformed',
		);
		const object = path.join(
			root,
			'.git',
			'objects',
			source.slice(0, 2),
			source.slice(2),
		);
		fs.chmodSync(object, 0o600);
		fs.writeFileSync(object, 'corrupt');
		await expect(probeSettlementSource(root, source)).rejects.toThrow(
			'UNCERTAIN',
		);
	});
	test('inherited repository-redirect environment cannot retarget probes or ref writes', async () => {
		const { root, source } = fixture();
		// A distinct repository that cannot contain `source`.
		const otherRoot = canonicalMkdtemp('settlement-source-3409-other-');
		roots.push(otherRoot);
		git(otherRoot, 'init', '--initial-branch=main');
		git(otherRoot, 'config', 'user.email', 'other@example.invalid');
		git(otherRoot, 'config', 'user.name', 'Other');
		git(otherRoot, 'commit', '--allow-empty', '-m', 'unrelated history');
		const ref = settlementBackupRef(source);
		const otherGit = path.join(otherRoot, '.git');
		const redirects: Record<string, string> = {
			GIT_DIR: otherGit,
			GIT_OBJECT_DIRECTORY: path.join(otherGit, 'objects'),
			GIT_WORK_TREE: otherRoot,
			GIT_INDEX_FILE: path.join(otherGit, 'index'),
			GIT_COMMON_DIR: otherGit,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(otherGit, 'objects'),
			GIT_NAMESPACE: 'foreign',
		};
		const saved = Object.fromEntries(
			Object.keys(redirects).map((key) => [key, process.env[key]]),
		);
		let probed: 'present' | 'absent';
		let preserved: string;
		try {
			Object.assign(process.env, redirects);
			probed = await probeSettlementSource(root, source);
			preserved = await preserveSettlementSource(root, source);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		// Without the scrub, the probe would query `other` (where this OID does
		// not exist) and the ref would be written there instead of in `root`.
		expect(probed).toBe('present');
		expect(preserved).toBe(ref);
		expect(git(root, 'rev-parse', '--verify', ref)).toBe(source);
		expect(() => git(otherRoot, 'rev-parse', '--verify', ref)).toThrow(
			/Needed a single revision/,
		);
		expect(process.env.GIT_DIR).toBe(saved.GIT_DIR);
	});
	test('inherited GIT_OBJECT_DIRECTORY to a missing path does not make the intended repository unreadable', async () => {
		const { root } = fixture();
		const saved = process.env.GIT_OBJECT_DIRECTORY;
		process.env.GIT_OBJECT_DIRECTORY = path.join(root, 'no-such-objects');
		try {
			expect(await probeSettlementSource(root, 'f'.repeat(40))).toBe('absent');
		} finally {
			if (saved === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
			else process.env.GIT_OBJECT_DIRECTORY = saved;
		}
	});
	test.each([
		'missing',
		'file',
	] as const)('an unusable %s object directory is uncertain, never absent', async (kind) => {
		const { root } = fixture();
		const bogus = path.join(root, 'bogus-objects');
		if (kind === 'file') fs.writeFileSync(bogus, 'not a directory');
		_internals.bunSpawn = (argv, options) => {
			if (argv.includes('--git-path')) {
				// Quiet-missing rev-parse already happened; the object-directory
				// location Git reports is now unusable (removed or not a directory).
				return {
					stdout: { text: async () => `${bogus}\n` },
					stderr: { text: async () => '' },
					exited: Promise.resolve(0),
					exitCode: 0,
					kill: () => {},
				} as unknown as ReturnType<typeof realSpawn>;
			}
			return realSpawn(argv, options);
		};
		const failure = await probeSettlementSource(root, 'f'.repeat(40)).then(
			() => undefined,
			(error: unknown) => error as Error,
		);
		expect(failure?.message).toStartWith(
			'CODER_SETTLEMENT_SOURCE_UNCERTAIN: object database unavailable',
		);
	});
	test('dispatch admission binds both live branch and exact HEAD', async () => {
		const { lane, branch, source, target } = fixture();
		await validateSettlementLane(lane, branch, source);
		await expect(validateSettlementLane(lane, branch, target)).rejects.toThrow(
			'DISPATCH_ARTIFACT_CHANGED',
		);
		await expect(
			validateSettlementLane(lane, 'different', source),
		).rejects.toThrow('DISPATCH_ARTIFACT_CHANGED');
	});
	test('advanced target already containing the initial source commit recovers remaining exact work', async () => {
		const { root, lane, branch, source, first, provenance } = fixture();
		// Seed the backup an interrupted earlier settlement would have left. A
		// 'merge' dispatch without commitLanding lands squash-unstaged (no merge
		// commit, HEAD does not move), and a squash-unstaged landing retains the
		// backup: working-tree bytes alone are not a committed copy
		// (docs/coder-settlement-recovery.md).
		const backup = await preserveSettlementSource(root, source);
		expect(git(root, 'rev-parse', '--verify', backup)).toBe(source);
		git(root, 'merge', '--no-edit', first);
		fs.writeFileSync(path.join(root, 'target.txt'), 'target\n');
		git(root, 'add', 'target.txt');
		git(root, 'commit', '-m', 'target advancement');
		const advanced = git(root, 'rev-parse', 'HEAD');
		const result = await attemptMergeBackFromDirty(
			lane,
			branch,
			root,
			'merge',
			{ resume: provenance, operationId: 'op' },
		);
		expect(result).toMatchObject({
			merged: true,
			strategy: 'squash-unstaged',
		});
		// No merge commit: HEAD stays at the advanced target, so the source is
		// not an ancestor and the remaining lane work is uncommitted.
		expect(git(root, 'rev-parse', 'HEAD')).toBe(advanced);
		expect(() =>
			git(root, 'merge-base', '--is-ancestor', source, 'HEAD'),
		).toThrow();
		expect(fs.readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe(
			'second\n',
		);
		expect(fs.readFileSync(path.join(root, 'target.txt'), 'utf8')).toBe(
			'target\n',
		);
		// Only the remaining exact work (second.txt) lands, unstaged; first.txt
		// was already in the target and is untouched.
		expect(
			git(
				root,
				'status',
				'--porcelain',
				'--untracked-files=all',
				'--',
				'.',
				':(exclude).swarm',
			),
		).toBe('?? second.txt');
		expect(git(root, 'diff', '--cached', '--name-only')).toBe('');
		expect(git(root, 'rev-parse', '--verify', backup)).toBe(source);
	});
	test('same target squash retains backup until a committed landing exists', async () => {
		const { root, lane, branch, source, target, provenance } = fixture();
		const result = await attemptMergeBackFromDirty(
			lane,
			branch,
			root,
			'merge',
			{ resume: provenance, operationId: 'op' },
		);
		expect(result).toMatchObject({ merged: true, strategy: 'squash-unstaged' });
		expect(git(root, 'rev-parse', 'HEAD')).toBe(target);
		expect(git(root, 'rev-parse', settlementBackupRef(source))).toBe(source);
	});
	test.each([
		'same',
		'different',
	] as const)('absent-ref CAS respects a %s racing winner', async (winner) => {
		const { root, lane, branch, source, target } = fixture();
		git(root, 'worktree', 'remove', '--force', lane);
		git(root, 'branch', '-D', branch);
		let raced = false;
		_internals.bunSpawn = (argv, options) => {
			if (
				!raced &&
				argv.includes('update-ref') &&
				argv.includes(`refs/heads/${branch}`)
			) {
				raced = true;
				git(
					root,
					'update-ref',
					`refs/heads/${branch}`,
					winner === 'same' ? source : target,
				);
			}
			return realSpawn(argv, options);
		};
		if (winner === 'same')
			expect(await restoreSettlementBranch(root, branch, source)).toBe(true);
		else
			await expect(
				restoreSettlementBranch(root, branch, source),
			).rejects.toThrow('cannot preserve');
		expect(raced).toBe(true);
		expect(git(root, 'rev-parse', branch)).toBe(
			winner === 'same' ? source : target,
		);
	});
	test('foreign backup identity refuses both preservation and release', async () => {
		const { root, source, target } = fixture();
		const ref = settlementBackupRef(source);
		git(root, 'update-ref', ref, target);
		await expect(preserveSettlementSource(root, source)).rejects.toThrow(
			'occupied ref',
		);
		await expect(releaseSettlementSource(root, source)).rejects.toThrow(
			'occupied backup',
		);
		expect(git(root, 'rev-parse', ref)).toBe(target);
	});
	test('backup deletion CAS preserves a competing different winner', async () => {
		const { root, source, target } = fixture();
		const ref = await preserveSettlementSource(root, source);
		let raced = false;
		_internals.bunSpawn = (argv, options) => {
			if (!raced && argv.includes('update-ref') && argv.includes('-d')) {
				raced = true;
				git(root, 'update-ref', ref, target);
			}
			return realSpawn(argv, options);
		};
		await expect(releaseSettlementSource(root, source)).rejects.toThrow(
			'cannot release',
		);
		expect(raced).toBe(true);
		expect(git(root, 'rev-parse', ref)).toBe(target);
	});
	test('advanced-target retry conflict aborts cleanly and retains recovery source', async () => {
		const { root, lane, branch, source, provenance } = fixture();
		fs.writeFileSync(path.join(root, 'second.txt'), 'competing target\n');
		git(root, 'add', 'second.txt');
		git(root, 'commit', '-m', 'conflicting target');
		const advanced = git(root, 'rev-parse', 'HEAD');
		const result = await attemptMergeBackFromDirty(
			lane,
			branch,
			root,
			'merge',
			{ resume: provenance, operationId: 'op' },
		);
		expect(result).toMatchObject({ failed: true, stage: 'merge' });
		expect('message' in result && result.message).toContain('CONFLICT');
		expect('message' in result && result.message).toContain('second.txt');
		expect('message' in result && result.message).not.toContain(
			'restore of pre-merge state incomplete',
		);
		expect(git(root, 'rev-parse', 'HEAD')).toBe(advanced);
		// Exact pre-attempt bytes: no conflict markers in the conflicted path.
		expect(fs.readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe(
			'competing target\n',
		);
		// The lane-added path absent from HEAD is gone from index and worktree;
		// the checkout is exactly as clean as before the attempt and the index
		// has no unmerged entries.
		expect(fs.existsSync(path.join(root, 'first.txt'))).toBe(false);
		expect(
			git(
				root,
				'status',
				'--porcelain',
				'--untracked-files=all',
				'--',
				'.',
				':(exclude).swarm',
			),
		).toBe('');
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(git(root, 'rev-parse', branch)).toBe(source);
		expect(git(root, 'rev-parse', settlementBackupRef(source))).toBe(source);
		expect(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD'))).toBe(false);
	});
	test('conflict restore never deletes an added path whose bytes are not the lane blob', async () => {
		const { root, lane, branch, source, provenance } = fixture();
		fs.writeFileSync(path.join(root, 'second.txt'), 'competing target\n');
		git(root, 'add', 'second.txt');
		git(root, 'commit', '-m', 'conflicting target');
		let injected = false;
		let squashed = false;
		mergeInternals.bunSpawn = (argv, options) => {
			if (argv.includes('--squash')) squashed = true;
			// A writer replaces the merge-written lane-added file after the
			// conflicted squash and before the restore records its own state (the
			// restore's `ls-files -s` is the first after the squash), so the
			// restore hashes the user's bytes and must not take them for lane output.
			if (
				squashed &&
				!injected &&
				argv.includes('ls-files') &&
				argv.includes('-s')
			) {
				injected = true;
				fs.writeFileSync(path.join(root, 'first.txt'), 'user bytes\n');
			}
			return realMergeSpawn(argv, options);
		};
		const result = await attemptMergeBackFromDirty(
			lane,
			branch,
			root,
			'merge',
			{ resume: provenance, operationId: 'op' },
		);
		expect(injected).toBe(true);
		expect(result).toMatchObject({ failed: true, stage: 'merge' });
		expect('message' in result && result.message).toContain(
			'restore of pre-merge state incomplete',
		);
		expect('message' in result && result.message).toContain(
			'left in place (not the exact lane bytes): first.txt',
		);
		expect(fs.readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe(
			'user bytes\n',
		);
		expect(fs.readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe(
			'competing target\n',
		);
		expect(git(root, 'ls-files', '-u')).toBe('');
		expect(git(root, 'rev-parse', settlementBackupRef(source))).toBe(source);
	});
	test('advanced-target retry overlap preserves dirty user bytes and source', async () => {
		const { root, lane, branch, source, provenance } = fixture();
		fs.writeFileSync(path.join(root, 'target.txt'), 'independent\n');
		git(root, 'add', 'target.txt');
		git(root, 'commit', '-m', 'advance target');
		const advanced = git(root, 'rev-parse', 'HEAD');
		fs.writeFileSync(path.join(root, 'second.txt'), 'user bytes\n');
		const result = await attemptMergeBackFromDirty(
			lane,
			branch,
			root,
			'merge',
			{ resume: provenance, operationId: 'op' },
		);
		expect(result).toMatchObject({ failed: true });
		expect('message' in result && result.message).toContain(
			'overlapping dirty paths',
		);
		expect(git(root, 'rev-parse', 'HEAD')).toBe(advanced);
		expect(fs.readFileSync(path.join(root, 'second.txt'), 'utf8')).toBe(
			'user bytes\n',
		);
		expect(git(root, 'rev-parse', settlementBackupRef(source))).toBe(source);
	});
	test('routine lane cleanup never enumerates or removes content-addressed backup refs', async () => {
		const { root, lane, branch, source } = fixture();
		const ref = await preserveSettlementSource(root, source);
		git(root, 'worktree', 'remove', '--force', lane);
		git(root, 'branch', '-D', branch);
		const result = await cleanupOrphanedBranches(root);
		expect(result.removed).toEqual([]);
		expect(git(root, 'rev-parse', ref)).toBe(source);
	});
});
