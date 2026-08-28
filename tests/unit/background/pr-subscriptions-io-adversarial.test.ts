import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	buildCorrelationId,
	listActive,
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_AUDIT_FILE,
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	PR_SUBSCRIPTIONS_FILE,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';

function makeTempProject(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pr-sub-io-adversarial-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	return dir;
}

function subscriptionInput(suffix: string) {
	const prNumber = Number(suffix.replace(/\D/g, '')) || 1;
	return {
		sessionID: `session-${suffix}`,
		prNumber,
		repoFullName: 'owner/repo',
		prUrl: `https://github.com/owner/repo/pull/${prNumber}`,
	};
}

function legacyRecord(suffix: string) {
	const input = subscriptionInput(suffix);
	const now = Date.now();
	return {
		correlationId: buildCorrelationId(
			input.sessionID,
			input.repoFullName,
			input.prNumber,
		),
		...input,
		lastCheckedAt: now,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active' as const,
		createdAt: now,
		updatedAt: now,
		errorCount: 0,
	};
}

describe('pr-subscriptions — I/O failure regressions (#2042)', () => {
	let dir: string;
	const realReadSync = _internals.readSync;
	const realArchiveStatSync = _internals.archiveStatSync;
	const realLegacyCloseSync = _internals.legacyCloseSync;
	const realLegacyFstatSync = _internals.legacyFstatSync;
	const realStatSync = _internals.statSync;
	const realRenameWithRetry = _internals.renameWithRetry;

	beforeEach(() => {
		dir = makeTempProject();
	});

	afterEach(() => {
		_internals.readSync = realReadSync;
		_internals.archiveStatSync = realArchiveStatSync;
		_internals.legacyCloseSync = realLegacyCloseSync;
		_internals.legacyFstatSync = realLegacyFstatSync;
		_internals.statSync = realStatSync;
		_internals.renameWithRetry = realRenameWithRetry;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('F13: legacy fold I/O failure closes the descriptor, preserves the source, and retries', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('1301');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		let closes = 0;
		_internals.legacyFstatSync = () => {
			throw Object.assign(new Error('injected legacy fstat failure'), {
				code: 'EIO',
			});
		};
		_internals.legacyCloseSync = (fd) => {
			closes += 1;
			realLegacyCloseSync(fd);
		};
		await expect(
			updateSnapshot(dir, seeded.correlationId, { errorCount: 1 }),
		).rejects.toThrow(/migration read failed/i);
		expect(closes).toBe(1);
		expect(fs.existsSync(legacy)).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(false);
		_internals.legacyFstatSync = realLegacyFstatSync;
		_internals.legacyCloseSync = realLegacyCloseSync;
		expect(
			(await updateSnapshot(dir, seeded.correlationId, { errorCount: 1 }))
				?.errorCount,
		).toBe(1);
	});

	test('F14: a failed read fold cannot bootstrap or archive state the caller did not observe', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('1401');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		let calls = 0;
		_internals.legacyFstatSync = (fd) => {
			calls += 1;
			if (calls === 1) throw new Error('injected one-shot read failure');
			return realLegacyFstatSync(fd);
		};
		expect(await listActive(dir)).toEqual([]);
		expect(calls).toBe(1);
		expect(fs.existsSync(legacy)).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(false);
		expect((await listActive(dir))[0]?.correlationId).toBe(
			seeded.correlationId,
		);
	});

	test('F15: a legal short checkpoint read loops to completion', async () => {
		const created = await subscribe(dir, subscriptionInput('1501'));
		let shortReads = 0;
		_internals.readSync = ((fd, buffer, offset, length, position) => {
			if (shortReads === 0 && length > 1) {
				shortReads += 1;
				return fs.readSync(
					fd,
					buffer,
					offset,
					Math.floor(length / 2),
					position,
				);
			}
			return fs.readSync(fd, buffer, offset, length, position);
		}) as typeof fs.readSync;
		expect((await listActive(dir))[0]?.correlationId).toBe(
			created.correlationId,
		);
		expect(shortReads).toBe(1);
		expect(
			(await updateSnapshot(dir, created.correlationId, { errorCount: 1 }))
				?.errorCount,
		).toBe(1);
	});

	test('F16: unreadable legacy metadata fails ordinary mutations closed', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		fs.writeFileSync(legacy, `${JSON.stringify(legacyRecord('1601'))}\n`);
		_internals.statSync = (filePath) => {
			if (path.resolve(filePath.toString()) === path.resolve(legacy))
				throw Object.assign(new Error('injected legacy stat failure'), {
					code: 'EACCES',
				});
			return realStatSync(filePath);
		};
		await expect(subscribe(dir, subscriptionInput('1602'))).rejects.toThrow(
			/refusing mutation/i,
		);
		expect(fs.existsSync(legacy)).toBe(true);
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(false);
	});

	test('F17: unreadable co-copied legacy metadata blocks foreign rebind', async () => {
		const source = makeTempProject();
		try {
			await subscribe(source, subscriptionInput('1701'));
			const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			const checkpoint = path.join(
				dir,
				'.swarm',
				PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
			);
			fs.copyFileSync(
				path.join(source, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				checkpoint,
			);
			fs.writeFileSync(legacy, `${JSON.stringify(legacyRecord('1702'))}\n`);
			_internals.statSync = (filePath) => {
				if (path.resolve(filePath.toString()) === path.resolve(legacy))
					throw Object.assign(
						new Error('injected foreign legacy stat failure'),
						{ code: 'EACCES' },
					);
				return realStatSync(filePath);
			};
			await expect(subscribe(dir, subscriptionInput('1703'))).rejects.toThrow(
				/refusing to rebind/i,
			);
			expect(fs.existsSync(checkpoint)).toBe(true);
			expect(fs.existsSync(legacy)).toBe(true);
		} finally {
			fs.rmSync(source, { recursive: true, force: true });
		}
	});

	test('F18: newline-free oversized records advance within the chunk budget without re-buffering', () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		fs.writeFileSync(
			legacy,
			'x'.repeat(2 * PR_SUBSCRIPTION_LIMITS.migrationChunkBytes),
		);
		const first = _internals.foldLegacyRegion(
			legacy,
			0,
			PR_SUBSCRIPTION_LIMITS.migrationChunkBytes,
		);
		expect(first.eof).toBe(false);
		expect(first.discardingOversizeLine).toBe(true);
		expect(first.corruptLines).toBe(1);
		expect(first.nextByte).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.migrationChunkBytes +
				PR_SUBSCRIPTION_LIMITS.readChunkBytes,
		);
		const second = _internals.foldLegacyRegion(
			legacy,
			first.nextByte,
			PR_SUBSCRIPTION_LIMITS.migrationChunkBytes,
			first.discardingOversizeLine,
		);
		expect(second.eof).toBe(true);
		expect(second.corruptLines).toBe(0);
	});

	test('F19: audit-tail compaction loops across short reads and retains newest transitions', async () => {
		await subscribe(dir, subscriptionInput('1901'));
		const audit = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_AUDIT_FILE);
		const lines = Array.from({ length: 10_000 }, (_, seq) =>
			JSON.stringify({ ts: seq, seq, kind: 'subscribe' }),
		);
		fs.writeFileSync(audit, `${lines.join('\n')}\n`);
		let shortRead = false;
		_internals.readSync = ((fd, buffer, offset, length, position) => {
			if (!shortRead && length > 1) {
				shortRead = true;
				return fs.readSync(
					fd,
					buffer,
					offset,
					Math.floor(length / 2),
					position,
				);
			}
			return fs.readSync(fd, buffer, offset, length, position);
		}) as typeof fs.readSync;
		await subscribe(dir, subscriptionInput('1902'));
		const compacted = fs.readFileSync(audit, 'utf-8');
		expect(shortRead).toBe(true);
		expect(compacted).toContain('"seq":9999');
	});

	test('F20: failed replacement archive rename preserves the previous rollback archive', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		fs.writeFileSync(legacy, `${JSON.stringify(legacyRecord('2001'))}\n`);
		await updateSnapshot(dir, legacyRecord('2001').correlationId, {
			errorCount: 1,
		});
		const archive = path.join(
			dir,
			'.swarm',
			'pr-monitor',
			'subscriptions.legacy.jsonl',
		);
		const previous = fs.readFileSync(archive, 'utf-8');
		fs.writeFileSync(legacy, `${JSON.stringify(legacyRecord('2002'))}\n`);
		_internals.renameWithRetry = (from, to) => {
			if (to.endsWith('.next'))
				throw Object.assign(new Error('injected archive rename failure'), {
					code: 'EACCES',
				});
			realRenameWithRetry(from, to);
		};
		await updateSnapshot(dir, legacyRecord('2002').correlationId, {
			errorCount: 1,
		});
		expect(fs.readFileSync(archive, 'utf-8')).toBe(previous);
		expect(fs.existsSync(legacy)).toBe(true);
	});

	test('F21: public reads preserve oversize-line continuation from a persisted migration cursor', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const unsafeSuffix = legacyRecord('2101');
		fs.writeFileSync(
			legacy,
			`${'x'.repeat(PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation)}${JSON.stringify(unsafeSuffix)}\n`,
		);
		await expect(subscribe(dir, subscriptionInput('2102'))).rejects.toThrow(
			'migration is in progress',
		);
		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		);
		expect(checkpoint.migration.discardingOversizeLine).toBe(true);
		expect(await listActive(dir)).toEqual([]);
	});

	test('F22: same-size rewrite restarts an incomplete generation without retaining partial records', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const oldRecord = legacyRecord('2201');
		const newRecord = legacyRecord('2202');
		const oldPrefix = `${JSON.stringify(oldRecord)}\n`;
		const newPrefix = `${JSON.stringify(newRecord)}\n`;
		expect(Buffer.byteLength(newPrefix)).toBe(Buffer.byteLength(oldPrefix));
		const filler = 'x'.repeat(
			PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation,
		);
		fs.writeFileSync(legacy, `${oldPrefix}${filler}`);
		await expect(subscribe(dir, subscriptionInput('2203'))).rejects.toThrow(
			'migration is in progress',
		);
		fs.writeFileSync(legacy, `${newPrefix}${filler}`);
		const future = new Date(Date.now() + 5_000);
		fs.utimesSync(legacy, future, future);
		await expect(subscribe(dir, subscriptionInput('2203'))).rejects.toThrow(
			'migration is in progress',
		);
		const active = await listActive(dir);
		expect(
			active.some((record) => record.correlationId === oldRecord.correlationId),
		).toBe(false);
		expect(
			active.some((record) => record.correlationId === newRecord.correlationId),
		).toBe(true);
	});

	test('F23: shorter rewrite clears stale continuation and partial records before retry', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const oldRecord = legacyRecord('2301');
		const newRecord = legacyRecord('2302');
		fs.writeFileSync(
			legacy,
			`${JSON.stringify(oldRecord)}\n${'x'.repeat(PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation)}`,
		);
		await expect(subscribe(dir, subscriptionInput('2303'))).rejects.toThrow(
			'migration is in progress',
		);
		fs.writeFileSync(legacy, `${JSON.stringify(newRecord)}\n`);
		const future = new Date(Date.now() + 5_000);
		fs.utimesSync(legacy, future, future);
		const created = await subscribe(dir, subscriptionInput('2303'));
		const active = await listActive(dir);
		expect(
			active.some((record) => record.correlationId === oldRecord.correlationId),
		).toBe(false);
		expect(active.map((record) => record.correlationId).sort()).toEqual(
			[newRecord.correlationId, created.correlationId].sort(),
		);
	});

	test('F24: interrupted archive swap reconciles previous and candidate into canonical paths', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('2401');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		await updateSnapshot(dir, seeded.correlationId, { errorCount: 1 });
		const archive = path.join(
			dir,
			'.swarm',
			'pr-monitor',
			'subscriptions.legacy.jsonl',
		);
		const next = `${archive}.next`;
		const previous = `${archive}.previous`;
		fs.copyFileSync(archive, next);
		fs.renameSync(archive, previous);
		await updateSnapshot(dir, seeded.correlationId, { errorCount: 2 });
		expect(fs.existsSync(archive)).toBe(true);
		expect(fs.existsSync(next)).toBe(false);
		expect(fs.existsSync(previous)).toBe(false);
		expect(fs.existsSync(legacy)).toBe(false);
	});

	test('F25: failed previous-archive restoration fails closed with both recovery files intact', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('2501');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		await updateSnapshot(dir, seeded.correlationId, { errorCount: 1 });
		const archive = path.join(
			dir,
			'.swarm',
			'pr-monitor',
			'subscriptions.legacy.jsonl',
		);
		const next = `${archive}.next`;
		const previous = `${archive}.previous`;
		fs.copyFileSync(archive, next);
		fs.renameSync(archive, previous);
		_internals.renameWithRetry = (from, to) => {
			if (from === previous && to === archive) {
				throw Object.assign(new Error('injected previous restore failure'), {
					code: 'EACCES',
				});
			}
			realRenameWithRetry(from, to);
		};
		await expect(
			updateSnapshot(dir, seeded.correlationId, { errorCount: 2 }),
		).rejects.toThrow('archive staging could not be reconciled');
		expect(fs.existsSync(archive)).toBe(false);
		expect(fs.existsSync(previous)).toBe(true);
		expect(fs.existsSync(next)).toBe(true);
	});

	test('F26: generation restart preserves the native pre-migration checkpoint baseline', async () => {
		const native = await subscribe(dir, subscriptionInput('2601'));
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const oldLegacy = legacyRecord('2602');
		const newLegacy = legacyRecord('2604');
		const oldPrefix = `${JSON.stringify(oldLegacy)}\n`;
		const newPrefix = `${JSON.stringify(newLegacy)}\n`;
		expect(Buffer.byteLength(newPrefix)).toBe(Buffer.byteLength(oldPrefix));
		const filler = 'x'.repeat(
			PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation,
		);
		fs.writeFileSync(legacy, `${oldPrefix}${filler}`);
		await expect(subscribe(dir, subscriptionInput('2603'))).rejects.toThrow(
			'migration is in progress',
		);
		fs.writeFileSync(legacy, `${newPrefix}${filler}`);
		const future = new Date(Date.now() + 5_000);
		fs.utimesSync(legacy, future, future);
		await expect(subscribe(dir, subscriptionInput('2603'))).rejects.toThrow(
			'migration is in progress',
		);
		const activeIds = (await listActive(dir))
			.map((record) => record.correlationId)
			.sort();
		expect(activeIds).toEqual(
			[native.correlationId, newLegacy.correlationId].sort(),
		);
		expect(activeIds).not.toContain(oldLegacy.correlationId);
	});

	test('F27: archive retention starts at archival time for an old legacy source', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('2701');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		const old = new Date(
			Date.now() - PR_SUBSCRIPTION_LIMITS.legacyArchiveTtlMs - 86_400_000,
		);
		fs.utimesSync(legacy, old, old);
		const beforeArchive = Date.now();
		await updateSnapshot(dir, seeded.correlationId, { errorCount: 1 });
		const archive = path.join(
			dir,
			'.swarm',
			'pr-monitor',
			'subscriptions.legacy.jsonl',
		);
		expect(fs.existsSync(archive)).toBe(true);
		expect(fs.statSync(archive).mtimeMs).toBeGreaterThanOrEqual(beforeArchive);
	});

	test('F28: transient archive stat failure defers without marking migration archived', async () => {
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const seeded = legacyRecord('2801');
		fs.writeFileSync(legacy, `${JSON.stringify(seeded)}\n`);
		_internals.archiveStatSync = () => {
			throw Object.assign(new Error('injected archive stat failure'), {
				code: 'EIO',
			});
		};
		await updateSnapshot(dir, seeded.correlationId, { errorCount: 1 });
		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		);
		expect(checkpoint.migration.archived).toBe(false);
		expect(fs.existsSync(legacy)).toBe(true);
	});
});
