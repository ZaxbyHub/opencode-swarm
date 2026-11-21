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
	git(['init', '-q']);
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

	test('a deletion-only backup with a manifest failure refuses the restore', async () => {
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
		const result = backupTrackedChangesBeforeRollback(dir as string, [
			'sample.txt',
		]);
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

	test('an empty dirty set keeps the null-dir behavior', () => {
		fixture();
		fs.mkdirSync(loc('.swarm'), { recursive: true });
		const result = backupTrackedChangesBeforeRollback(dir as string, []);
		expect(result.backupDir).toBeNull();
		expect(result.recoveryComplete).toBe(false);
	}, 30000);
});
