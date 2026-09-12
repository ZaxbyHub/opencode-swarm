/**
 * #2577: destination-lock admission contract for the memory family migration.
 *
 * A held live destination lock must not be bypassable: when acquisition of the
 * destination storage-directory lock fails, `migrateMemoryFamily` fails closed
 * with a typed, bounded, retryable error and leaves both the destination and
 * the source untouched. Mirrors the #2575 Full-Auto locking suite
 * (tests/unit/full-auto/state-locking.test.ts) for the memory cohort engine.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
	_internals,
	migrateMemoryFamily,
} from '../../../src/memory/memory-family-migration';
import type { VettedMemoryRoot } from '../../../src/memory/storage-root';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originalLockfile = _internals.lockfile;

let tmpDir: string;

beforeEach(() => {
	tmpDir = canonicalMkdtemp('swarm-migration-lock-');
	_internals.lockfile = originalLockfile;
});

afterEach(() => {
	_internals.lockfile = originalLockfile;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup after a failed contention test.
	}
});

function localRoot(directory: string): VettedMemoryRoot {
	return { kind: 'local', root: path.join(directory, '.swarm'), directory };
}

function cohortRoot(cohortDir: string, directory: string): VettedMemoryRoot {
	return {
		kind: 'cohort',
		cohortRoot: path.join(cohortDir, 'memory'),
		cohortId: 'lock-test-cohort',
		generation: 1,
		linkId: 'lock-test-link',
		directory,
	};
}

function seedJsonl(storageDir: string, filename: string, ids: string[]): void {
	fs.mkdirSync(storageDir, { recursive: true });
	fs.writeFileSync(
		path.join(storageDir, filename),
		ids.map((id) => JSON.stringify({ id })).join('\n') + '\n',
		'utf-8',
	);
}

function readIds(storageDir: string, filename: string): string[] {
	const p = path.join(storageDir, filename);
	if (!fs.existsSync(p)) return [];
	return fs
		.readFileSync(p, 'utf-8')
		.split('\n')
		.filter((l) => l.trim())
		.map((l) => (JSON.parse(l) as { id: string }).id);
}

interface TreeSnapshot {
	entries: string[];
	files: Map<string, string>;
}

function snapshotTree(rootDir: string): TreeSnapshot {
	const entries: string[] = [];
	const files = new Map<string, string>();
	const walk = (dir: string, rel: string): void => {
		for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${item.name}` : item.name;
			entries.push(`${item.isDirectory() ? 'd' : 'f'} ${relPath}`);
			if (item.isDirectory()) walk(path.join(dir, item.name), relPath);
			else {
				files.set(relPath, fs.readFileSync(path.join(dir, item.name), 'utf-8'));
			}
		}
	};
	walk(rootDir, '');
	entries.sort();
	return { entries, files };
}

function seedLinkPair(
	base: string,
	destIds: string[],
	srcIds: string[],
): {
	dest: string;
	source: string;
	destRoot: VettedMemoryRoot;
	srcRoot: VettedMemoryRoot;
} {
	const wtDir = path.join(base, 'wt');
	const cohortDir = path.join(base, 'cohort');
	const dest = path.join(cohortDir, 'memory');
	const source = path.join(wtDir, '.swarm', 'memory');
	seedJsonl(dest, 'memories.jsonl', destIds);
	seedJsonl(source, 'memories.jsonl', srcIds);
	return {
		dest,
		source,
		destRoot: cohortRoot(cohortDir, wtDir),
		srcRoot: localRoot(wtDir),
	};
}

describe('memory family migration destination-lock admission', () => {
	test('held live destination lock fails closed typed and untouched (link direction)', async () => {
		const { dest, source, destRoot, srcRoot } = seedLinkPair(
			path.join(tmpDir, 'link'),
			['dest-1'],
			['src-1'],
		);
		const destBefore = snapshotTree(dest);
		const sourceBefore = snapshotTree(source);
		const release = await lockfile.lock(dest, {
			stale: 60_000,
			realpath: false,
		});
		try {
			const startedAt = performance.now();
			let rejection: unknown;
			await migrateMemoryFamily(destRoot, srcRoot).catch((err) => {
				rejection = err;
			});
			const elapsedMs = performance.now() - startedAt;
			expect(rejection).toBeDefined();
			const error = rejection as Error & {
				category?: string;
				code?: string;
			};
			expect(error.message.toLowerCase()).toContain('contention');
			expect(error.message.toLowerCase()).toContain('retry');
			// Bounded, host-path-free failure text (the #2575 no-leak rule).
			expect(error.message.length).toBeLessThanOrEqual(4096);
			expect(error.message).not.toContain(tmpDir);
			expect(error.category).toBe('contention');
			expect(error.code).toBe('MEMORY_MIGRATION_LOCK_CONTENTION');
			// The underlying ELOCKED-shaped cause is preserved for diagnostics.
			expect((error as { cause?: { code?: string } }).cause).toMatchObject({
				code: 'ELOCKED',
			});
			// The shared bounded retry budget must be honored before failing:
			// the schedule sums to 4200 ms, so a short-circuited retry loop
			// (well under half the budget) must not pass this floor.
			expect(elapsedMs).toBeGreaterThanOrEqual(2000);
			// Failed admission preserves destination and source exactly.
			expect(snapshotTree(dest)).toEqual(destBefore);
			expect(snapshotTree(source)).toEqual(sourceBefore);
			expect(fs.existsSync(path.join(dest, 'backups'))).toBe(false);
			// The holder's live lock was not stolen or deleted.
			expect(fs.existsSync(`${dest}.lock`)).toBe(true);
		} finally {
			await release().catch(() => {});
		}
	}, 20_000);

	test('held live destination lock fails closed typed and untouched (unlink direction)', async () => {
		// Unlink migrates cohort -> local: the destination is the LOCAL root,
		// which the JSONL provider legitimately locks on the same path.
		const wtDir = path.join(tmpDir, 'unlink-wt');
		const cohortDir = path.join(tmpDir, 'unlink-cohort');
		const dest = path.join(wtDir, '.swarm', 'memory');
		const source = path.join(cohortDir, 'memory');
		seedJsonl(dest, 'memories.jsonl', ['local-1']);
		seedJsonl(source, 'memories.jsonl', ['cohort-1']);
		const destBefore = snapshotTree(dest);
		const sourceBefore = snapshotTree(source);
		const release = await lockfile.lock(dest, {
			stale: 60_000,
			realpath: false,
		});
		try {
			const startedAt = performance.now();
			const rejection = await migrateMemoryFamily(
				localRoot(wtDir),
				cohortRoot(cohortDir, wtDir),
			).then(
				() => undefined,
				(err: unknown) => err,
			);
			const elapsedMs = performance.now() - startedAt;
			expect(rejection).toBeDefined();
			const error = rejection as Error & {
				category?: string;
				code?: string;
			};
			expect(error.message.toLowerCase()).toContain('contention');
			expect(error.message.toLowerCase()).toContain('retry');
			expect(error.message.length).toBeLessThanOrEqual(4096);
			expect(error.message).not.toContain(tmpDir);
			expect(error.category).toBe('contention');
			expect(error.code).toBe('MEMORY_MIGRATION_LOCK_CONTENTION');
			// Same bounded-retry evidence floor as the link direction.
			expect(elapsedMs).toBeGreaterThanOrEqual(2000);
			expect(snapshotTree(dest)).toEqual(destBefore);
			expect(snapshotTree(source)).toEqual(sourceBefore);
			// The unlocked unlink path used to mkdir backups/ before any
			// memory.db check; failed admission must not litter.
			expect(fs.existsSync(path.join(dest, 'backups'))).toBe(false);
			// The holder's live lock was not stolen or deleted.
			expect(fs.existsSync(`${dest}.lock`)).toBe(true);
		} finally {
			await release().catch(() => {});
		}
	}, 20_000);

	test('classifies an ELOCKED acquisition failure as typed contention', async () => {
		const { dest, source, destRoot, srcRoot } = seedLinkPair(
			path.join(tmpDir, 'taxonomy-locked'),
			['dest-1'],
			['src-1'],
		);
		const destBefore = snapshotTree(dest);
		const sourceBefore = snapshotTree(source);
		_internals.lockfile = {
			lock: () =>
				Promise.reject(
					Object.assign(new Error('Lock file is already being held'), {
						code: 'ELOCKED',
					}),
				),
		};
		const rejection = await migrateMemoryFamily(destRoot, srcRoot).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(rejection).toBeDefined();
		const error = rejection as Error & { category?: string; code?: string };
		expect(error.category).toBe('contention');
		expect(error.code).toBe('MEMORY_MIGRATION_LOCK_CONTENTION');
		expect(snapshotTree(dest)).toEqual(destBefore);
		expect(snapshotTree(source)).toEqual(sourceBefore);
	});

	test('classifies a non-ELOCKED acquisition failure as typed storage', async () => {
		const { dest, destRoot, srcRoot } = seedLinkPair(
			path.join(tmpDir, 'taxonomy-storage'),
			['dest-1'],
			['src-1'],
		);
		const destBefore = snapshotTree(dest);
		_internals.lockfile = {
			lock: () =>
				Promise.reject(
					Object.assign(new Error('permission denied'), { code: 'EACCES' }),
				),
		};
		const rejection = await migrateMemoryFamily(destRoot, srcRoot).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(rejection).toBeDefined();
		const error = rejection as Error & { category?: string; code?: string };
		expect(error.category).toBe('storage');
		expect(error.code).toBe('MEMORY_MIGRATION_LOCK_STORAGE');
		expect(error.message.toLowerCase()).not.toContain('contention');
		expect(snapshotTree(dest)).toEqual(destBefore);
	});

	test('two concurrent legitimate migrations serialize without lost rows', async () => {
		const wtA = path.join(tmpDir, 'wt-a');
		const wtB = path.join(tmpDir, 'wt-b');
		const cohortDir = path.join(tmpDir, 'cohort');
		const dest = path.join(cohortDir, 'memory');
		seedJsonl(dest, 'memories.jsonl', ['dest-1']);
		seedJsonl(path.join(wtA, '.swarm', 'memory'), 'memories.jsonl', [
			'a-1',
			'a-2',
		]);
		seedJsonl(path.join(wtB, '.swarm', 'memory'), 'memories.jsonl', [
			'b-1',
			'b-2',
		]);
		const [a, b] = await Promise.all([
			migrateMemoryFamily(cohortRoot(cohortDir, wtA), localRoot(wtA)),
			migrateMemoryFamily(cohortRoot(cohortDir, wtB), localRoot(wtB)),
		]);
		expect(a.perMember.find((m) => m.filename === 'memories.jsonl')).toEqual({
			filename: 'memories.jsonl',
			merged: 2,
			skipped: 0,
		});
		expect(b.perMember.find((m) => m.filename === 'memories.jsonl')).toEqual({
			filename: 'memories.jsonl',
			merged: 2,
			skipped: 0,
		});
		expect(new Set(readIds(dest, 'memories.jsonl'))).toEqual(
			new Set(['dest-1', 'a-1', 'a-2', 'b-1', 'b-2']),
		);
	}, 20_000);

	test('completes when contention clears within the bounded retry budget', async () => {
		const { dest, destRoot, srcRoot } = seedLinkPair(
			path.join(tmpDir, 'retryable'),
			['dest-1'],
			['src-1'],
		);
		const release = await lockfile.lock(dest, {
			stale: 60_000,
			realpath: false,
		});
		const migration = migrateMemoryFamily(destRoot, srcRoot);
		await new Promise<void>((resolve) => {
			setTimeout(() => {
				release()
					.catch(() => {})
					.then(resolve, resolve);
			}, 1_200);
		});
		const result = await migration;
		expect(
			result.perMember.find((m) => m.filename === 'memories.jsonl'),
		).toMatchObject({ merged: 1, skipped: 0 });
		expect(readIds(dest, 'memories.jsonl')).toEqual(['dest-1', 'src-1']);
	}, 20_000);

	test('uncontended migration retains counts and stays idempotent', async () => {
		const { dest, destRoot, srcRoot } = seedLinkPair(
			path.join(tmpDir, 'uncontended'),
			['dest-1', 'dest-2'],
			['src-1', 'dest-1'],
		);
		const first = await migrateMemoryFamily(destRoot, srcRoot);
		expect(
			first.perMember.find((m) => m.filename === 'memories.jsonl'),
		).toEqual({ filename: 'memories.jsonl', merged: 1, skipped: 1 });
		expect(readIds(dest, 'memories.jsonl')).toEqual([
			'dest-1',
			'dest-2',
			'src-1',
		]);
		const afterFirst = snapshotTree(dest);
		const second = await migrateMemoryFamily(destRoot, srcRoot);
		expect(
			second.perMember.find((m) => m.filename === 'memories.jsonl'),
		).toEqual({ filename: 'memories.jsonl', merged: 0, skipped: 2 });
		expect(snapshotTree(dest)).toEqual(afterFirst);
	});
});
