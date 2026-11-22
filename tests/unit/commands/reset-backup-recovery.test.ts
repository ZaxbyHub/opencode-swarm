/**
 * Rollback recovery backup (#3763 AC3/AC4/AC5, plan v3 D2/D3).
 *
 * RED at base, GREEN after the fix (#3763) for the capture/manifest legs;
 * the failure-injection legs pin the fail-closed gate (critic round 1
 * blocker 3: a recovery writer failure refuses the reset even when the file
 * copies succeeded).
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import {
	backupTrackedChangesBeforeRollback,
	_internals as resetBackupInternals,
} from '../../../src/commands/reset-backup';
import {
	checkpoint,
	_internals as checkpointInternals,
} from '../../../src/tools/checkpoint';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string | undefined;
let manifestWriter:
	| typeof resetBackupInternals.writeRecoveryManifest
	| undefined;

afterEach(() => {
	if (manifestWriter !== undefined) {
		resetBackupInternals.writeRecoveryManifest = manifestWriter;
		manifestWriter = undefined;
	}
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
	dir = canonicalMkdtemp('rbrec-');
	// FB-007/FB-014 (#3763 feedback round): pin the initial branch — the
	// unmerged-capture test checks `master` out by name.
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
	({ directory: dir, worktree: dir, sessionID: 'rbrec' }) as ToolContext;

async function call(
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const r = await checkpoint.execute(args, ctx());
	return JSON.parse(typeof r === 'string' ? r : r.output);
}

function capture(rel: string): { mode: string } | null {
	return checkpointInternals.captureIndexEntryForBackup({
		directory: dir as string,
		backupDir: path.join(dir as string, '.swarm', 'probe-backup'),
		rel,
	});
}

describe('rollback recovery backup (#3763)', () => {
	test('binary staged blobs round-trip byte-exactly through the index capture', () => {
		fixture();
		const binary = Buffer.from([
			0xff, 0xfe, 0x00, 0x41, 0x00, 0x80, 0xc3, 0xbf,
		]);
		fs.writeFileSync(loc('sample.txt'), binary);
		git(['add', 'sample.txt']);
		const result = capture('sample.txt');
		expect(result).not.toBeNull();
		expect(result?.mode).toBe('100644');
		const captured = fs.readFileSync(
			path.join(dir as string, '.swarm', 'probe-backup', 'index', 'sample.txt'),
		);
		expect(Buffer.compare(captured, binary)).toBe(0);
	}, 30000);

	test('the staged executable mode is recorded in the manifest entry', () => {
		fixture();
		fs.writeFileSync(loc('sample.txt'), 'stage B');
		git(['add', 'sample.txt']);
		git(['update-index', '--chmod=+x', 'sample.txt']);
		const result = capture('sample.txt');
		expect(result?.mode).toBe('100755');
	}, 30000);

	test('a manifest-write failure after successful copies refuses the restore and preserves state', async () => {
		fixture();
		// Baseline checkpoint to restore toward.
		await call({ action: 'save', label: 'base' });
		fs.writeFileSync(loc('sample.txt'), 'work C');
		git(['add', 'sample.txt']);
		manifestWriter = resetBackupInternals.writeRecoveryManifest;
		resetBackupInternals.writeRecoveryManifest = () => {
			throw new Error('manifest writer boom');
		};
		const preview = await call({ action: 'restore', label: 'base' });
		expect(preview.requires_confirm).toBe(true);
		const token = String(preview.confirm_token);
		const result = await call({
			action: 'restore',
			label: 'base',
			confirm_token: token,
		});
		// Copies succeeded but the recovery writer failed: the restore must
		// refuse (AC5 generalized — critic round 1 blocker 3).
		expect(result.success).toBe(false);
		expect(String(result.error)).toContain('recovery capture incomplete');
		// Nothing was destroyed.
		expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('work C');
		expect(git(['show', ':sample.txt'])).toBe('work C');
	}, 30000);

	test('a deletion-only backup with a manifest failure refuses the restore (FB-010: cause pinned)', async () => {
		fixture();
		await call({ action: 'save', label: 'base' });
		fs.unlinkSync(loc('sample.txt'));
		manifestWriter = resetBackupInternals.writeRecoveryManifest;
		resetBackupInternals.writeRecoveryManifest = () => {
			throw new Error('manifest writer boom');
		};
		const preview = await call({ action: 'restore', label: 'base' });
		expect(preview.requires_confirm).toBe(true);
		const result = await call({
			action: 'restore',
			label: 'base',
			confirm_token: String(preview.confirm_token),
		});
		expect(result.success).toBe(false);
		// FB-010: pin the SPECIFIC fail-closed cause, not just success=false —
		// an unrelated refusal must not satisfy this oracle.
		expect(String(result.error)).toContain('recovery capture incomplete');
		expect(String(result.error)).toContain('failed to write recovery manifest');
		// The deletion was NOT consumed.
		expect(fs.existsSync(loc('sample.txt'))).toBe(false);
	}, 30000);

	test('an index-capture failure marks recovery incomplete at the function level', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const result = backupTrackedChangesBeforeRollback(
			dir as string,
			['sample.txt'],
			{
				captureIndexEntry: () => {
					throw new Error('cat-file boom');
				},
			},
		);
		expect(result.backupDir).not.toBeNull();
		expect(result.recoveryComplete).toBe(false);
		expect(result.warnings.some((w) => w.includes('cat-file boom'))).toBe(true);
	}, 30000);

	test('deletion-only backups record the deletion and complete recovery', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.unlinkSync(loc('sample.txt'));
		const result = backupTrackedChangesBeforeRollback(
			dir as string,
			['sample.txt'],
			{ confirmDeletion: (rel) => gitDeletionSet().has(rel) },
		);
		expect(result.backupDir).not.toBeNull();
		expect(result.recoveryComplete).toBe(true);
		expect(result.recordedDeletions).toEqual(['sample.txt']);
		const manifest = JSON.parse(
			fs.readFileSync(
				path.join(result.backupDir as string, 'recovery.json'),
				'utf8',
			),
		);
		expect(manifest.entries['sample.txt'].worktree.kind).toBe('deleted');
	}, 30000);

	// FB-001 (#3763 feedback round): deletions must be git-CONFIRMED. A path
	// that is simply invisible to fs — e.g. a name corrupted by lossy
	// non-UTF-8 decoding of porcelain bytes (POSIX class) — must NOT be
	// recorded as deleted; it flips recoveryComplete and the restore refuses.
	function gitDeletionSet(): Set<string> {
		const out = execFileSync(
			'git',
			['status', '--porcelain', '-z', '--untracked-files=all'],
			{
				cwd: dir as string,
				encoding: 'utf8',
				timeout: 15000,
				maxBuffer: 32768,
			},
		);
		const set = new Set<string>();
		for (const token of out.split('\0')) {
			if (!token) continue;
			const xy = token.slice(0, 2);
			if (xy[0] === 'D' || xy[1] === 'D') set.add(token.slice(3));
		}
		return set;
	}

	test('an UNCONFIRMED missing path refuses recovery instead of recording a deletion (FB-001)', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		// 'ghost\uFFFD.txt' imitates a lossy-decoded name: absent from disk
		// AND from any git deletion record.
		const result = backupTrackedChangesBeforeRollback(
			dir as string,
			['ghost\uFFFD.txt'],
			{ confirmDeletion: () => false },
		);
		expect(result.recoveryComplete).toBe(false);
		expect(result.recordedDeletions).toEqual([]);
		expect(
			result.warnings.some((w) => w.includes('cannot confirm worktree state')),
		).toBe(true);
	}, 30000);

	test('copies and confirmed deletions coexist in one honest capture pass', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		fs.writeFileSync(loc('sample.txt'), 'edited');
		const mixed = backupTrackedChangesBeforeRollback(
			dir as string,
			['sample.txt', 'ghost.txt'],
			{ confirmDeletion: (rel) => rel === 'ghost.txt' },
		);
		expect(mixed.recoveryComplete).toBe(true);
		expect(mixed.copied).toEqual(['sample.txt']);
		expect(mixed.recordedDeletions).toEqual(['ghost.txt']);
	}, 30000);

	test('end-to-end: an unconfirmable dirty path refuses the restore with the cause named (FB-001/FB-010)', async () => {
		fixture();
		await call({ action: 'save', label: 'base' });
		fs.writeFileSync(loc('sample.txt'), 'work C');
		const realMeasure = checkpointInternals.measureGitDestruction;
		checkpointInternals.measureGitDestruction = (async (
			_directory: string,
			_sha: string,
		) => ({
			kind: 'ok' as const,
			dirtyRelPaths: ['sample.txt', 'ghost\uFFFD.txt'],
			excludedOutOfRoot: [],
		})) as typeof realMeasure;
		try {
			const preview = await call({ action: 'restore', label: 'base' });
			expect(preview.requires_confirm).toBe(true);
			const result = await call({
				action: 'restore',
				label: 'base',
				confirm_token: String(preview.confirm_token),
			});
			expect(result.success).toBe(false);
			expect(String(result.error)).toContain('recovery capture incomplete');
			expect(String(result.error)).toContain('cannot confirm worktree state');
			// Nothing destroyed: the working edit survives the refusal.
			expect(fs.readFileSync(loc('sample.txt'), 'utf8')).toBe('work C');
		} finally {
			checkpointInternals.measureGitDestruction = realMeasure;
		}
	}, 30000);

	test('end-to-end restore backs up BINARY staged and working bytes exactly (FB-015)', async () => {
		fixture();
		const binaryCommitted = Buffer.from([0xde, 0xad, 0x00, 0xbe, 0x01]);
		fs.writeFileSync(loc('sample.txt'), binaryCommitted);
		git(['add', 'sample.txt']);
		git(['commit', '-qm', 'binary base']);
		const saved = await call({ action: 'save', label: 'bin' });
		expect(saved.success).toBe(true);
		// FB-015 round 2: make INDEX, WORKTREE, and CHECKPOINT bytes three
		// DISTINCT binary blobs — with index==HEAD the old shape could not
		// tell an honest index capture from a HEAD copy.
		const binaryStaged = Buffer.from([0x00, 0x80, 0xfe, 0xff, 0x02, 0x00]);
		fs.writeFileSync(loc('sample.txt'), binaryStaged);
		git(['add', 'sample.txt']);
		const binaryWork = Buffer.from([0x01, 0x02, 0x03, 0xf0, 0x0d, 0x00, 0x7f]);
		fs.writeFileSync(loc('sample.txt'), binaryWork);
		const preview = await call({ action: 'restore', label: 'bin' });
		expect(preview.requires_confirm).toBe(true);
		const result = await call({
			action: 'restore',
			label: 'bin',
			confirm_token: String(preview.confirm_token),
		});
		expect(result.success).toBe(true);
		// backup_dir is absolute (backupTrackedChanges returns absolute paths).
		const backupDir = String(result.backup_dir);
		expect(
			Buffer.compare(
				fs.readFileSync(path.join(backupDir, 'tracked', 'sample.txt')),
				binaryWork,
			),
		).toBe(0);
		expect(
			Buffer.compare(
				fs.readFileSync(path.join(backupDir, 'index', 'sample.txt')),
				binaryStaged,
			),
		).toBe(0);
		// The reset applied: working bytes are the checkpoint's committed
		// content — not the staged bytes and not the destroyed dirty bytes.
		expect(
			Buffer.compare(fs.readFileSync(loc('sample.txt')), binaryCommitted),
		).toBe(0);
	}, 60000);

	test('an empty dirty set keeps the null-dir behavior', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		const result = backupTrackedChangesBeforeRollback(dir as string, []);
		expect(result.backupDir).toBeNull();
		expect(result.recoveryComplete).toBe(false);
	}, 30000);

	test('an UNREADABLE (EACCES-class) gitlink worktree entry fails closed — never a covered gitlink (FB-003 round 4)', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		// Index reports a gitlink; the worktree entry exists but lstat fails
		// with a non-ENOENT error. Round-3 treated ANY lstat error as absent →
		// directory-like → covered unbacked; round 4 only ENOENT/ENOTDIR count
		// as absent, an errored stat fails closed.
		const eacces = Object.assign(new Error('EACCES: permission denied'), {
			code: 'EACCES',
		});
		const result = backupTrackedChangesBeforeRollback(dir as string, ['mod'], {
			captureIndexEntry: () => ({
				mode: '160000',
				gitlink: true,
				sha: 'f'.repeat(40),
			}),
			confirmDeletion: () => false,
			lstatImpl: () => {
				throw eacces;
			},
		});
		expect(result.gitlinkPaths).toEqual([]);
		expect(result.recoveryComplete).toBe(false);
		expect(
			result.warnings.some((w) => w.includes('cannot stat worktree entry')),
		).toBe(true);
	}, 30000);
});
