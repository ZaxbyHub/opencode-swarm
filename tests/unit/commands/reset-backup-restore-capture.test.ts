/**
 * Rollback recovery backup — capture-heavy legs (#3763 feedback round).
 *
 * Split from reset-backup-recovery.test.ts under the FR-006 500-line cap.
 * Covers: gitlink (submodule) capture + restore-gate coverage (FB-003),
 * the authoritative-status-unreadable restore refusal (FB-001), symlink
 * classification (FB-022), exact-set dedupe (FB-017), and root containment
 * (FB-019). RED at base for the capture legs, GREEN after the fix.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	backupTrackedChangesBeforeRollback,
	isUnsafeDirtyRelPath,
} from '../../../src/commands/reset-backup';
import {
	checkpoint,
	_internals as checkpointInternals,
} from '../../../src/tools/checkpoint';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string | undefined;

afterEach(() => {
	if (dir) fs.rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

function git(args: string[]): string {
	if (!dir) throw new Error('missing scratch project');
	return execFileSync('git', args, {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 15000,
		maxBuffer: 32768,
	}).trim();
}

function loc(rel: string): string {
	return path.join(dir as string, rel);
}

function fixture(): void {
	dir = canonicalMkdtemp('rbcap-');
	git(['init', '-q', '-b', 'master']);
	git(['config', 'user.email', 'test@example.invalid']);
	git(['config', 'user.name', 'Fixture']);
	git(['config', 'commit.gpgsign', 'false']);
	git(['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(loc('sample.txt'), 'original');
	git(['add', 'sample.txt']);
	git(['commit', '-qm', 'fixture']);
}

const ctx = (): ToolContext =>
	({ directory: dir, worktree: dir, sessionID: 'rbcap' }) as ToolContext;

async function call(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const r = await checkpoint.execute(args, ctx());
	return JSON.parse(typeof r === 'string' ? r : r.output);
}

function capture(rel: string): {
	mode: string;
	gitlink?: boolean;
	sha?: string;
} | null {
	return checkpointInternals.captureIndexEntryForBackup({
		directory: dir as string,
		backupDir: path.join(dir as string, '.swarm', 'probe-backup'),
		rel,
	});
}

describe('rollback recovery capture-heavy legs (#3763 feedback round)', () => {
	test('symlinks are recorded with their kind and target (FB-022)', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		const probe = loc('link-probe.txt');
		fs.writeFileSync(probe, 'target bytes');
		let canSymlink = true;
		try {
			fs.symlinkSync('link-probe.txt', loc('link-probe-link.txt'));
		} catch (e) {
			// Capability refusal only; cleanup errors never masquerade as skip.
			const cap = ['EPERM', 'ENOSYS', 'EOPNOTSUPP'];
			if (!cap.includes(String((e as NodeJS.ErrnoException).code))) {
				throw e;
			}
			canSymlink = false;
		}
		if (canSymlink) fs.rmSync(loc('link-probe-link.txt'), { force: true });
		if (!canSymlink && process.platform !== 'win32') {
			throw new Error('symlink probe failed on a symlink-capable host');
		}
		if (!canSymlink) return;
		fs.writeFileSync(loc('link.txt'), 'will become a symlink target holder');
		git(['add', 'link.txt']);
		git(['commit', '-qm', 'link base']);
		fs.rmSync(loc('link.txt'));
		fs.symlinkSync('sample.txt', loc('link.txt'));
		fs.symlinkSync('no-such-target.txt', loc('dangling.txt'));
		const result = backupTrackedChangesBeforeRollback(
			dir as string,
			['link.txt', 'dangling.txt'],
			{ confirmDeletion: () => false },
		);
		expect(result.recoveryComplete).toBe(true);
		expect(result.copied).toContain('link.txt');
		expect(result.copied).toContain('dangling.txt');
		const manifest = JSON.parse(
			fs.readFileSync(
				path.join(result.backupDir as string, 'recovery.json'),
				'utf8',
			),
		);
		expect(manifest.entries['link.txt'].worktree.kind).toBe('symlink');
		expect(manifest.entries['link.txt'].worktree.target).toBe('sample.txt');
		expect(
			fs.readlinkSync(
				path.join(result.backupDir as string, 'tracked', 'link.txt'),
			),
		).toBe('sample.txt');
		expect(manifest.entries['dangling.txt'].worktree.kind).toBe('symlink');
		expect(manifest.entries['dangling.txt'].worktree.target).toBe(
			'no-such-target.txt',
		);
		expect(
			fs.readlinkSync(
				path.join(result.backupDir as string, 'tracked', 'dangling.txt'),
			),
		).toBe('no-such-target.txt');
	}, 30000);

	test('duplicate measured paths are recorded once — exact-set semantics (FB-017)', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = backupTrackedChangesBeforeRollback(dir as string, [
			'sample.txt',
			'sample.txt',
		]);
		expect(result.copied).toEqual(['sample.txt']);
	}, 30000);

	test('a measured path escaping the project root fails closed and writes nothing (FB-019)', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('escape.txt'), 'outside bytes');
		const result = backupTrackedChangesBeforeRollback(dir as string, [
			'../escape.txt',
		]);
		expect(result.recoveryComplete).toBe(false);
		expect(
			result.warnings.some((w) => w.includes('outside the project root')),
		).toBe(true);
		expect(result.backupDir).not.toBeNull();
		expect(
			fs.existsSync(path.join(result.backupDir as string, 'tracked')),
		).toBe(false);
	}, 30000);

	test('a staged blob LARGER than the old 5 MB pipe cap streams to disk (FB-003)', () => {
		fixture();
		const big = Buffer.alloc(6 * 1024 * 1024, 0x41);
		fs.writeFileSync(loc('sample.txt'), big);
		git(['add', 'sample.txt']);
		const result = capture('sample.txt');
		// Pre-fix: cat-file hit ENOBUFS at 5 MB and refused the restore.
		expect(result?.mode).toBe('100644');
		const captured = fs.readFileSync(
			path.join(dir as string, '.swarm', 'probe-backup', 'index', 'sample.txt'),
		);
		expect(captured.length).toBe(big.length);
		expect(Buffer.compare(captured, big)).toBe(0);
	}, 120000);

	test('a dirty gitlink (mode 160000) records its sha instead of refusing the capture (FB-003)', () => {
		fixture();
		const sub = path.join(dir as string, 'subsrc');
		fs.mkdirSync(sub, { recursive: true });
		const subGit = (args: string[]) =>
			execFileSync('git', args, {
				cwd: sub,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 15000,
			});
		subGit(['init', '-q']);
		subGit(['config', 'user.email', 'test@example.invalid']);
		subGit(['config', 'user.name', 'Fixture']);
		fs.writeFileSync(path.join(sub, 'f.txt'), 's1');
		subGit(['add', '-A']);
		subGit(['commit', '-qm', 'sub base']);
		execFileSync(
			'git',
			[
				'-c',
				'protocol.file.allow=always',
				'submodule',
				'add',
				'-q',
				sub,
				'mod',
			],
			{
				cwd: dir as string,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 30000,
			},
		);
		git(['add', '-A']);
		git(['commit', '-qm', 'super base']);
		fs.writeFileSync(path.join(dir, 'mod', 'f.txt'), 's2');
		execFileSync('git', ['commit', '-qam', 'sub moved'], {
			cwd: path.join(dir, 'mod'),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 15000,
		});
		const result = capture('mod');
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('160000');
		expect(result?.gitlink).toBe(true);
		expect(typeof result?.sha).toBe('string');
		// FB-003 round 2: pre-fix the submodule DIRECTORY was non-regular → restore refused.
		fs.mkdirSync(loc('.swarm'), { recursive: true }); // backup root requirement
		const backup = backupTrackedChangesBeforeRollback(dir as string, ['mod'], {
			captureIndexEntry: (input) =>
				checkpointInternals.captureIndexEntryForBackup({
					directory: dir as string,
					...input,
				}),
			confirmDeletion: () => false,
		});
		expect(backup.recoveryComplete).toBe(true);
		expect(backup.warnings).toEqual([]);
		const gitlinkManifest = JSON.parse(
			fs.readFileSync(
				path.join(backup.backupDir as string, 'recovery.json'),
				'utf8',
			),
		);
		expect(gitlinkManifest.entries.mod.worktree.kind).toBe('gitlink');
		expect(gitlinkManifest.entries.mod.index.gitlink).toBe(true);
	}, 60000);

	test('restore gate treats a dirty submodule (gitlink) as honestly covered, not uncovered (FB-003 gate path)', async () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		const saved = await call({ action: 'save', label: 'modckpt' });
		expect(saved.success).toBe(true);
		// REAL handleRestore gate: 'mod' is dirty (absent from disk, not a git
		// deletion) but classified gitlink, so it counts via gitlinkPaths.
		const realCapture = checkpointInternals.captureIndexEntryForBackup;
		const realMeasure = checkpointInternals.measureGitDestruction;
		checkpointInternals.captureIndexEntryForBackup = ((input: {
			directory: string;
			backupDir: string;
			rel: string;
		}) =>
			input.rel === 'mod'
				? { mode: '160000', gitlink: true, sha: 'f'.repeat(40) }
				: realCapture(input)) as typeof realCapture;
		checkpointInternals.measureGitDestruction = (async () => ({
			kind: 'ok' as const,
			dirtyRelPaths: ['mod'],
			excludedOutOfRoot: [],
		})) as typeof realMeasure;
		try {
			const preview = await call({ action: 'restore', label: 'modckpt' });
			expect(preview.requires_confirm).toBe(true);
			const result = await call({
				action: 'restore',
				label: 'modckpt',
				confirm_token: String(preview.confirm_token),
			});
			expect(String(result.error ?? '')).not.toContain('uncovered');
			expect(result.success).toBe(true);
			expect(typeof result.backup_dir).toBe('string');
		} finally {
			checkpointInternals.captureIndexEntryForBackup = realCapture;
			checkpointInternals.measureGitDestruction = realMeasure;
		}
	}, 30000);

	test('restore refuses when the authoritative deletion-confirmation read fails, even over fully-present files (FB-001)', async () => {
		fixture();
		const saved = await call({ action: 'save', label: 'fb001' });
		expect(saved.success).toBe(true);
		// A PRESENT dirty file: without the gate, lossy-decoded siblings could collide.
		fs.writeFileSync(loc('sample.txt'), 'edited again');
		const real = checkpointInternals.statusTokensFatal;
		checkpointInternals.statusTokensFatal = (() => {
			throw new Error('simulated lossy porcelain decode');
		}) as typeof real;
		try {
			const preview = await call({ action: 'restore', label: 'fb001' });
			expect(preview.requires_confirm).toBe(true);
			const result = await call({
				action: 'restore',
				label: 'fb001',
				confirm_token: String(preview.confirm_token),
			});
			expect(result.success).toBe(false);
			expect(String(result.error)).toContain(
				'authoritative git status unreadable',
			);
			// Nothing destroyed.
			expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('edited again');
		} finally {
			checkpointInternals.statusTokensFatal = real;
		}
	}, 30000);

	test('an unmerged index record refuses the capture (FB-014)', () => {
		fixture();
		fs.writeFileSync(loc('conflict.txt'), 'base');
		git(['add', 'conflict.txt']);
		git(['commit', '-qm', 'conflict base']);
		git(['checkout', '-q', '-b', 'side']);
		fs.writeFileSync(loc('conflict.txt'), 'side');
		git(['commit', '-qam', 'side']);
		git(['checkout', '-q', 'master']);
		fs.writeFileSync(loc('conflict.txt'), 'master');
		git(['commit', '-qam', 'master']);
		try {
			git(['merge', 'side']);
		} catch {
			// expected conflict
		}
		expect(git(['status', '--porcelain'])).toContain('UU');
		expect(() => capture('conflict.txt')).toThrow('unmerged index records');
	}, 30000);

	// --- round 3 (stage B round-2 findings) ---------------------------------

	function buildSubmodule(): void {
		const sub = path.join(dir as string, 'subsrc');
		fs.mkdirSync(sub, { recursive: true });
		const subGit = (args: string[]) =>
			execFileSync('git', args, {
				cwd: sub,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 15000,
			});
		subGit(['init', '-q']);
		subGit(['config', 'user.email', 'test@example.invalid']);
		subGit(['config', 'user.name', 'Fixture']);
		fs.writeFileSync(path.join(sub, 'f.txt'), 's1');
		subGit(['add', '-A']);
		subGit(['commit', '-qm', 'sub base']);
		execFileSync(
			'git',
			[
				'-c',
				'protocol.file.allow=always',
				'submodule',
				'add',
				'-q',
				sub.split('\\').join('/'),
				'mod',
			],
			{
				cwd: dir as string,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 30000,
			},
		);
		git(['add', '-A']);
		git(['commit', '-qm', 'super base']);
	}

	test('a gitlink whose worktree entry is a regular FILE (typechange) backs up the bytes — never a phantom gitlink (FB-003 round 3)', () => {
		fixture();
		buildSubmodule();
		// Submodule DIRECTORY replaced by a regular file (index still
		// 160000): a gitlink shortcut trusting the index would fake coverage.
		fs.rmSync(loc('mod'), { recursive: true, force: true });
		fs.writeFileSync(loc('mod'), 'precious-replacement-bytes\n');
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		const backup = backupTrackedChangesBeforeRollback(dir as string, ['mod'], {
			captureIndexEntry: (input) =>
				checkpointInternals.captureIndexEntryForBackup({
					directory: dir as string,
					...input,
				}),
			confirmDeletion: () => false,
		});
		expect(backup.gitlinkPaths).toEqual([]);
		expect(backup.copied).toContain('mod');
		expect(backup.recoveryComplete).toBe(true);
		const manifest = JSON.parse(
			fs.readFileSync(
				path.join(backup.backupDir as string, 'recovery.json'),
				'utf8',
			),
		);
		expect(manifest.entries.mod.worktree.kind).toBe('file');
		// The INDEX is still honestly recorded as a gitlink (no blob was read).
		expect(manifest.entries.mod.index.gitlink).toBe(true);
		expect(
			fs.readFileSync(
				path.join(backup.backupDir as string, 'tracked', 'mod'),
				'utf8',
			),
		).toBe('precious-replacement-bytes\n');
	}, 60000);

	test('restore proceeds end-to-end over a dirty real submodule (gitlink) — gate coverage without stubs (FB-003 round 3)', async () => {
		fixture();
		buildSubmodule();
		const saved = await call({ action: 'save', label: 'subckpt' });
		expect(saved.success).toBe(true);
		// Advance the submodule HEAD so the superproject sees ' M mod'.
		fs.writeFileSync(path.join(dir as string, 'mod', 'f.txt'), 's2');
		execFileSync('git', ['commit', '-qam', 'sub moved'], {
			cwd: path.join(dir as string, 'mod'),
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			timeout: 15000,
		});
		expect(git(['status', '--porcelain'])).toContain('mod');
		const preview = await call({ action: 'restore', label: 'subckpt' });
		expect(preview.requires_confirm).toBe(true);
		const result = await call({
			action: 'restore',
			label: 'subckpt',
			confirm_token: String(preview.confirm_token),
		});
		expect(String(result.error ?? '')).not.toContain('uncovered');
		expect(result.success).toBe(true);
	}, 60000);

	test('containment is platform-aware: POSIX keeps literal-backslash names, Windows blocks backslash traversal (FB-018 round 4)', () => {
		const isWin = path.sep === '\\';
		// Safe relative names, and always-rejected forms.
		expect(isUnsafeDirtyRelPath('a.txt')).toBe(false);
		expect(isUnsafeDirtyRelPath('a/b/c.txt')).toBe(false);
		expect(isUnsafeDirtyRelPath('')).toBe(true);
		expect(isUnsafeDirtyRelPath('/abs')).toBe(true);
		expect(isUnsafeDirtyRelPath('../x')).toBe(true);
		expect(isUnsafeDirtyRelPath('a/../b')).toBe(true);
		expect(isUnsafeDirtyRelPath('nul\0x')).toBe(true);
		// Backslash without traversal is a literal filename byte on both.
		expect(isUnsafeDirtyRelPath('a\\b')).toBe(false);
		// Rejected only where '\' is a separator (path.join would escape).
		expect(isUnsafeDirtyRelPath('..\\x')).toBe(isWin);
		expect(isUnsafeDirtyRelPath('a\\..\\b')).toBe(isWin);
		expect(isUnsafeDirtyRelPath('a\\../\\..\\x')).toBe(isWin);
		expect(isUnsafeDirtyRelPath('C:\\evil')).toBe(isWin);
	});

	test('copies routed through an escaping parent directory fail closed (FB-019 round 4)', () => {
		fixture();
		const outside = canonicalMkdtemp('rb-out-');
		try {
			fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-BYTES');
			// A 'junction' needs no SeCreateSymbolicLink privilege on Windows.
			let parentLinkOk = true;
			try {
				fs.symlinkSync(outside, loc('linkout'), 'junction');
			} catch {
				try {
					fs.symlinkSync(outside, loc('linkout'));
				} catch {
					parentLinkOk = false;
				}
			}
			if (!parentLinkOk && process.platform !== 'win32') {
				throw new Error('dir-link probe failed on a link-capable host');
			}
			if (!parentLinkOk) return; // privileged-Windows-only skip
			fs.mkdirSync(loc('.swarm'), { recursive: true });
			const viaFile = backupTrackedChangesBeforeRollback(
				dir as string,
				['linkout/secret.txt'],
				{ confirmDeletion: () => false },
			);
			expect(viaFile.recoveryComplete).toBe(false);
			expect(
				viaFile.warnings.some((w) => w.includes('escapes the project root')),
			).toBe(true);
			expect(viaFile.copied).toEqual([]);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	}, 30000);
});
