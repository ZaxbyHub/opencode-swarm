import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	handleResetCommand,
	_internals as resetInternals,
} from '../../../src/commands/reset';
import {
	backupSwarmStateBeforeReset,
	RESET_BACKUP_RETENTION,
} from '../../../src/commands/reset-backup';

const tempRoots: string[] = [];

function makeRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-backup-'));
	tempRoots.push(root);
	fs.mkdirSync(path.join(root, '.swarm'), { recursive: true });
	return root;
}

function write(root: string, rel: string, contents: string): void {
	const full = path.join(root, '.swarm', rel);
	fs.mkdirSync(path.dirname(full), { recursive: true });
	fs.writeFileSync(full, contents, 'utf-8');
}

function backupsRoot(root: string): string {
	return path.join(root, '.swarm', 'reset-backups');
}

afterEach(() => {
	while (tempRoots.length > 0) {
		const r = tempRoots.pop();
		if (r) fs.rmSync(r, { recursive: true, force: true });
	}
});

describe('backupSwarmStateBeforeReset', () => {
	test('copies only the existing listed entries, preserving subpaths', () => {
		const root = makeRoot();
		write(root, 'plan.json', '{"a":1}');
		write(root, 'plan-export/SWARM_PLAN.json', '{"b":2}');
		// 'context.md' intentionally absent — must be skipped, not error.

		const result = backupSwarmStateBeforeReset(root, 'reset', [
			'plan.json',
			'context.md',
			'plan-export/SWARM_PLAN.json',
		]);

		expect(result.backupDir).not.toBeNull();
		expect(result.copied.sort()).toEqual([
			'plan-export/SWARM_PLAN.json',
			'plan.json',
		]);
		const dir = result.backupDir as string;
		expect(fs.readFileSync(path.join(dir, 'plan.json'), 'utf-8')).toBe(
			'{"a":1}',
		);
		expect(
			fs.readFileSync(
				path.join(dir, 'plan-export', 'SWARM_PLAN.json'),
				'utf-8',
			),
		).toBe('{"b":2}');
		expect(fs.existsSync(path.join(dir, 'context.md'))).toBe(false);
	});

	test('recursively backs up directories (e.g. session/)', () => {
		const root = makeRoot();
		write(root, 'session/state.json', '{"s":1}');
		write(root, 'session/nested/extra.txt', 'x');

		const result = backupSwarmStateBeforeReset(root, 'reset-session', [
			'session',
		]);

		const dir = result.backupDir as string;
		expect(result.copied).toEqual(['session']);
		expect(
			fs.readFileSync(path.join(dir, 'session', 'state.json'), 'utf-8'),
		).toBe('{"s":1}');
		expect(
			fs.readFileSync(
				path.join(dir, 'session', 'nested', 'extra.txt'),
				'utf-8',
			),
		).toBe('x');
	});

	test('returns null backupDir and creates nothing when no entry exists', () => {
		const root = makeRoot();
		const result = backupSwarmStateBeforeReset(root, 'reset', [
			'plan.json',
			'context.md',
		]);
		expect(result.backupDir).toBeNull();
		expect(result.copied).toEqual([]);
		// No empty backup directory left behind.
		expect(fs.existsSync(backupsRoot(root))).toBe(false);
	});

	test('returns null when .swarm/ does not exist (fail-open)', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-backup-nodir-'));
		tempRoots.push(root);
		const result = backupSwarmStateBeforeReset(root, 'reset', ['plan.json']);
		expect(result.backupDir).toBeNull();
		expect(result.warnings).toEqual([]);
	});

	test('refuses a symlinked .swarm/ directory (returns null, copies nothing)', () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), 'reset-backup-symlink-'),
		);
		tempRoots.push(root);
		const realTarget = fs.mkdtempSync(
			path.join(os.tmpdir(), 'reset-backup-symlink-target-'),
		);
		tempRoots.push(realTarget);
		fs.writeFileSync(path.join(realTarget, 'plan.json'), '{"a":1}');
		fs.symlinkSync(realTarget, path.join(root, '.swarm'), 'dir');

		const result = backupSwarmStateBeforeReset(root, 'reset', ['plan.json']);

		expect(result.backupDir).toBeNull();
		expect(result.copied).toEqual([]);
		// Nothing was created under the redirected target.
		expect(fs.existsSync(path.join(realTarget, 'reset-backups'))).toBe(false);
	});

	test('rejects path-traversal entries via a warning, without escaping .swarm', () => {
		const root = makeRoot();
		write(root, 'plan.json', '{}');
		const result = backupSwarmStateBeforeReset(root, 'reset', [
			'plan.json',
			'../escape.txt',
		]);
		expect(result.copied).toEqual(['plan.json']);
		expect(result.warnings.some((w) => w.includes('escape.txt'))).toBe(true);
	});

	test('prunes to the newest RESET_BACKUP_RETENTION backup directories', () => {
		const root = makeRoot();
		write(root, 'plan.json', '{}');
		// Pre-seed more than the retention limit of OLD backup dirs.
		const seeded: string[] = [];
		for (let i = 0; i < RESET_BACKUP_RETENTION + 3; i++) {
			// Names sort chronologically; use an increasing prefix well below the
			// real timestamp produced by the call under test so they count as older.
			const name = `reset-2000-01-01T00-00-0${i}-000Z`;
			fs.mkdirSync(path.join(backupsRoot(root), name), { recursive: true });
			fs.writeFileSync(path.join(backupsRoot(root), name, 'plan.json'), 'old');
			seeded.push(name);
		}

		backupSwarmStateBeforeReset(root, 'reset', ['plan.json']);

		const remaining = fs
			.readdirSync(backupsRoot(root), { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.map((e) => e.name)
			.sort();
		expect(remaining.length).toBe(RESET_BACKUP_RETENTION);
		// The just-created (newest) backup must survive; the oldest seeded must not.
		expect(remaining).not.toContain(seeded[0]);
	});
});

// Command-level wiring (kept here rather than in reset.test.ts to respect the
// FR-006 500-line cap on that already-large file). reset.ts does not import
// src/state, so no state mock is needed. #1692.
describe('reset command auto-backup wiring', () => {
	test('/swarm reset --confirm backs up before deleting, and still deletes', async () => {
		const root = makeRoot();
		write(root, 'plan.json', '{"title":"keep"}');
		write(root, 'context.md', '# ctx');

		const result = await handleResetCommand(root, ['--confirm']);

		expect(result).toContain('📦 Backed up');
		expect(fs.existsSync(path.join(root, '.swarm', 'plan.json'))).toBe(false);
		const dirs = fs.readdirSync(backupsRoot(root));
		expect(dirs.length).toBeGreaterThanOrEqual(1);
		const planCopy = path.join(backupsRoot(root), dirs[0], 'plan.json');
		expect(fs.readFileSync(planCopy, 'utf-8')).toBe('{"title":"keep"}');
	});

	test('/swarm reset --confirm is fail-open when the backup throws', async () => {
		const root = makeRoot();
		write(root, 'plan.json', '{}');
		const original = resetInternals.backupSwarmStateBeforeReset;
		resetInternals.backupSwarmStateBeforeReset = () => {
			throw new Error('boom');
		};
		try {
			const result = await handleResetCommand(root, ['--confirm']);
			expect(result).toContain('Auto-backup failed');
			expect(fs.existsSync(path.join(root, '.swarm', 'plan.json'))).toBe(false);
		} finally {
			resetInternals.backupSwarmStateBeforeReset = original;
		}
	});
});
