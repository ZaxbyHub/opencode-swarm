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
	sweepStale,
	unsubscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';

function makeTempProject(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-pr-sub-adversarial-')),
	);
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	return dir;
}

function subscriptionInput(suffix: string) {
	return {
		sessionID: `session-${suffix}`,
		prNumber: Number(suffix.replace(/\D/g, '')) || 1,
		repoFullName: 'owner/repo',
		prUrl: `https://github.com/owner/repo/pull/${Number(suffix.replace(/\D/g, '')) || 1}`,
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

describe('pr-subscriptions — adversarial persistence regressions (#2042)', () => {
	let dir: string;
	const realReadSync = _internals.readSync;
	const realAfterCheckpointFstat = _internals.afterCheckpointFstat;
	const realBeforeArchiveLegacy = _internals.beforeArchiveLegacy;
	const realBeforeArchiveRename = _internals.beforeArchiveRename;
	const realBeforeBootstrapLock = _internals.beforeBootstrapLock;
	const realRenameWithRetry = _internals.renameWithRetry;
	const realWriteCheckpointFile = _internals.writeCheckpointFile;

	beforeEach(() => {
		dir = makeTempProject();
	});

	afterEach(() => {
		_internals.afterCheckpointFstat = realAfterCheckpointFstat;
		_internals.beforeArchiveLegacy = realBeforeArchiveLegacy;
		_internals.beforeArchiveRename = realBeforeArchiveRename;
		_internals.beforeBootstrapLock = realBeforeBootstrapLock;
		_internals.readSync = realReadSync;
		_internals.renameWithRetry = realRenameWithRetry;
		_internals.writeCheckpointFile = realWriteCheckpointFile;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('F1: oversized legacy state rejects every mutation without publishing a shadowing checkpoint', async () => {
		// Previous code operated from an empty checkpoint view, so the first
		// successful mutation made every unabsorbed legacy subscription invisible.
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		fs.writeFileSync(legacy, '');
		fs.truncateSync(legacy, PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes + 1);
		const rejectingOperations = [
			() => subscribe(dir, subscriptionInput('101')),
			() =>
				updateSnapshot(dir, 'session-old::owner/repo::99', { errorCount: 1 }),
			() => unsubscribe(dir, 'session-old::owner/repo::99'),
		];
		for (const operation of rejectingOperations) {
			await expect(operation()).rejects.toThrow(/exceeds.*migration ceiling/i);
			expect(
				fs.existsSync(
					path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				),
			).toBe(false);
		}
		// sweepStale preserves its public fail-open error contract, but must still
		// avoid publishing checkpoint state that hides the oversized legacy source.
		expect(await sweepStale(dir, 1)).toBe(0);
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(false);
	});

	test('F2: foreign checkpoint and co-copied legacy state are both quarantined before rebind', async () => {
		// Previous code rejected the foreign checkpoint but immediately folded the
		// copied legacy file, re-adopting the wrong project's active monitor.
		const source = makeTempProject();
		try {
			await subscribe(source, subscriptionInput('201'));
			const old = legacyRecord('202');
			fs.copyFileSync(
				path.join(source, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
			);
			fs.writeFileSync(
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE),
				`${JSON.stringify(old)}\n`,
			);

			const created = await subscribe(dir, subscriptionInput('203'));
			const active = await listActive(dir);
			expect(active.map((record) => record.correlationId)).toEqual([
				created.correlationId,
			]);
			expect(
				fs.existsSync(
					path.join(
						dir,
						'.swarm',
						'pr-monitor',
						'subscriptions.legacy.foreign.jsonl',
					),
				),
			).toBe(true);
			expect(
				fs.existsSync(
					path.join(
						dir,
						'.swarm',
						'pr-monitor',
						'subscriptions.checkpoint.foreign.json',
					),
				),
			).toBe(true);
		} finally {
			fs.rmSync(source, { recursive: true, force: true });
		}
	});

	test('F3: externally oversized audit compaction reads no more than the high-water tail', async () => {
		// Previous code called readFileSync on the complete externally enlarged
		// audit file before rewriting it, recreating the availability defect.
		await subscribe(dir, subscriptionInput('301'));
		const audit = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_AUDIT_FILE);
		fs.writeFileSync(
			audit,
			'{"ts":1,"seq":1,"kind":"subscribe"}\n'.repeat(100_000),
		);
		let maxRequested = 0;
		_internals.readSync = ((
			fd: number,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number | null,
		) => {
			maxRequested = Math.max(maxRequested, length);
			return fs.readSync(fd, buffer, offset, length, position);
		}) as typeof fs.readSync;

		await subscribe(dir, subscriptionInput('302'));
		expect(maxRequested).toBeGreaterThan(0);
		expect(maxRequested).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.auditMaxBytesHigh,
		);
		expect(fs.statSync(audit).size).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.auditMaxBytesLow,
		);
	});

	test('F4: checkpoint writer applies the hard ceiling to UTF-8 bytes', async () => {
		// Previous code counted JavaScript characters, allowing multibyte content
		// that the byte-counting reader would reject and quarantine after restart.
		const created = await subscribe(dir, subscriptionInput('401'));
		await expect(
			updateSnapshot(dir, created.correlationId, {
				headRefOid: 'é'.repeat(600_000),
			}),
		).rejects.toThrow(/checkpoint capacity/i);
		const [persisted] = await listActive(dir);
		expect(persisted.headRefOid).toBeUndefined();
	});

	test('F5: migration work is capped per mutation and resumes without losing the tail', async () => {
		// Previous code looped through the entire permitted 64 MiB legacy source
		// under one evidence-lock acquisition despite its 1 MiB progress cursor.
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const tail = legacyRecord('502');
		const fillerLine = `${'x'.repeat(1024)}\n`;
		const fillerLines = Math.ceil(
			(PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation +
				2 * PR_SUBSCRIPTION_LIMITS.migrationChunkBytes) /
				Buffer.byteLength(fillerLine),
		);
		fs.writeFileSync(
			legacy,
			`${fillerLine.repeat(fillerLines)}${JSON.stringify(tail)}\n`,
		);

		await expect(subscribe(dir, subscriptionInput('501'))).rejects.toThrow(
			/migration is in progress/i,
		);
		const checkpoint = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				'utf-8',
			),
		);
		expect(checkpoint.migration.done).toBe(false);
		expect(checkpoint.migration.scannedBytes).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.migrationMaxBytesPerOperation +
				PR_SUBSCRIPTION_LIMITS.migrationChunkBytes,
		);

		const created = await subscribe(dir, subscriptionInput('501'));
		const active = await listActive(dir);
		expect(active.map((record) => record.correlationId).sort()).toEqual(
			[created.correlationId, tail.correlationId].sort(),
		);
	});

	test('F6: zero cooldown survives checkpoint replay', async () => {
		const created = await subscribe(dir, subscriptionInput('601'));
		await updateSnapshot(dir, created.correlationId, {
			customCooldownSeconds: 0,
		});
		const [replayed] = await listActive(dir);
		expect(replayed.correlationId).toBe(created.correlationId);
		expect(replayed.customCooldownSeconds).toBe(0);
	});

	test('F7: a failed foreign checkpoint quarantine cannot expose copied legacy state on retry', async () => {
		const source = makeTempProject();
		try {
			await subscribe(source, subscriptionInput('701'));
			const copiedLegacy = legacyRecord('702');
			fs.copyFileSync(
				path.join(source, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
			);
			fs.writeFileSync(
				path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE),
				`${JSON.stringify(copiedLegacy)}\n`,
			);
			let renameCalls = 0;
			_internals.renameWithRetry = (from, to) => {
				renameCalls += 1;
				if (renameCalls === 2) {
					throw Object.assign(new Error('injected checkpoint rename failure'), {
						code: 'EACCES',
					});
				}
				realRenameWithRetry(from, to);
			};

			await expect(subscribe(dir, subscriptionInput('703'))).rejects.toThrow(
				/could not be quarantined/i,
			);
			expect(renameCalls).toBe(2);
			expect(
				fs.existsSync(
					path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE),
				),
			).toBe(true);
			_internals.renameWithRetry = realRenameWithRetry;
			const created = await subscribe(dir, subscriptionInput('703'));
			expect(
				(await listActive(dir)).map((record) => record.correlationId),
			).toEqual([created.correlationId]);
		} finally {
			fs.rmSync(source, { recursive: true, force: true });
		}
	});

	test('F8: read bootstrap refuses a same-size legacy rewrite raced before lock acquisition', async () => {
		const first = legacyRecord('801');
		const replacement = legacyRecord('802');
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const firstLine = `${JSON.stringify(first)}\n`;
		const replacementLine = `${JSON.stringify(replacement)}\n`;
		expect(Buffer.byteLength(replacementLine)).toBe(
			Buffer.byteLength(firstLine),
		);
		fs.writeFileSync(legacy, firstLine);
		const originalTimes = fs.statSync(legacy);
		_internals.beforeBootstrapLock = () => {
			fs.writeFileSync(legacy, replacementLine);
			fs.utimesSync(legacy, originalTimes.atime, originalTimes.mtime);
		};

		expect((await listActive(dir))[0]?.correlationId).toBe(first.correlationId);
		expect(
			fs.existsSync(path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE)),
		).toBe(true);
		_internals.beforeBootstrapLock = realBeforeBootstrapLock;
		expect((await listActive(dir))[0]?.correlationId).toBe(
			replacement.correlationId,
		);
	});

	test('F9: a failed checkpoint write cannot append an audit transition', async () => {
		const created = await subscribe(dir, subscriptionInput('901'));
		const audit = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_AUDIT_FILE);
		fs.appendFileSync(
			audit,
			'{"ts":1,"seq":1,"kind":"subscribe"}\n'.repeat(10_000),
		);
		const before = fs.readFileSync(audit, 'utf-8');
		_internals.writeCheckpointFile = () => {
			throw new Error('injected checkpoint failure');
		};

		await expect(
			updateSnapshot(dir, created.correlationId, { headRefOid: 'new-head' }),
		).rejects.toThrow(/injected checkpoint failure/);
		expect(fs.readFileSync(audit, 'utf-8')).toBe(before);
		_internals.writeCheckpointFile = realWriteCheckpointFile;
		expect((await listActive(dir))[0]?.headRefOid).toBeUndefined();
	});

	test('F10: invalid runtime snapshot updates reject without corrupting the checkpoint', async () => {
		const created = await subscribe(dir, subscriptionInput('1001'));
		await expect(
			updateSnapshot(dir, created.correlationId, {
				status: 'bogus',
			} as unknown as Parameters<typeof updateSnapshot>[2]),
		).rejects.toThrow(/invalid subscription record/i);
		const [replayed] = await listActive(dir);
		expect(replayed.correlationId).toBe(created.correlationId);
		expect(replayed.status).toBe('active');
	});

	test('F11: a same-size legacy rewrite before archive remains visible and is not archived', async () => {
		const first = legacyRecord('1101');
		const replacement = legacyRecord('1102');
		const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
		const firstLine = `${JSON.stringify(first)}\n`;
		const replacementLine = `${JSON.stringify(replacement)}\n`;
		expect(Buffer.byteLength(replacementLine)).toBe(
			Buffer.byteLength(firstLine),
		);
		fs.writeFileSync(legacy, firstLine);
		_internals.beforeArchiveRename = () => {
			fs.writeFileSync(legacy, replacementLine);
			const future = new Date(Date.now() + 2_000);
			fs.utimesSync(legacy, future, future);
		};

		await updateSnapshot(dir, first.correlationId, { errorCount: 1 });
		expect(fs.existsSync(legacy)).toBe(true);
		_internals.beforeArchiveRename = realBeforeArchiveRename;
		expect(
			(await listActive(dir)).map((record) => record.correlationId),
		).toContain(replacement.correlationId);
	});

	test('F12: checkpoint growth after fstat cannot enlarge the bounded descriptor read', async () => {
		await subscribe(dir, subscriptionInput('1201'));
		let requestedBytes = 0;
		_internals.afterCheckpointFstat = (filePath) => {
			fs.truncateSync(
				filePath,
				PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes + 1024,
			);
		};
		_internals.readSync = ((fd, buffer, offset, length, position) => {
			requestedBytes += length;
			return fs.readSync(fd, buffer, offset, length, position);
		}) as typeof fs.readSync;

		await listActive(dir);
		expect(requestedBytes).toBeGreaterThan(0);
		expect(requestedBytes).toBeLessThanOrEqual(
			PR_SUBSCRIPTION_LIMITS.checkpointHardReadBytes,
		);
	});
});
