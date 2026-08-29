/**
 * Issue #2042 — PR-monitor subscription store health: recovery sources,
 * copied-state (foreign checkpoint) safety, corrupt-checkpoint quarantine,
 * audit bounds counters, telemetry emission, and the /swarm pr status footer.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	getPrSubscriptionHealth,
	listActive,
	lookupByPr,
	PR_SUBSCRIPTION_LIMITS,
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	PR_SUBSCRIPTIONS_FILE,
	type PrSubscriptionCheckpoint,
	type PrSubscriptionRecord,
	subscribe,
	unsubscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import {
	handlePrMonitorStatusCommand,
	_internals as statusInternals,
} from '../../../src/commands/pr-monitor-status';
import { _internals as telemetryInternals } from '../../../src/telemetry';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-hlth-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
	return dir;
}

function checkpointPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

function legacyPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
}

function record(
	sessionID: string,
	prNumber: number,
	updatedAt = Date.now(),
): PrSubscriptionRecord {
	return {
		correlationId: `${sessionID}::o/r::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		lastCheckedAt: updatedAt,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: updatedAt,
		updatedAt,
		errorCount: 0,
	};
}

function baseCheckpoint(dir: string): PrSubscriptionCheckpoint {
	return {
		schemaVersion: 1,
		sequence: 1,
		rootPath: path.resolve(dir),
		updatedAt: Date.now(),
		records: {},
		terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
		migration: null,
		maintenance: {
			compactions: 0,
			droppedAuditTransitions: 0,
			corruptLegacyRecords: 0,
			lastCompactedAt: null,
			resets: 0,
		},
	};
}

describe('pr-subscriptions health + recovery', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('empty store reports the empty recovery source and never throws', async () => {
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('empty');
		expect(health.activeCount).toBe(0);
		expect(health.sequence).toBe(0);
		expect(health.checkpointBytes).toBe(0);
	});

	test('legacy-only store reports legacy-log with folded counts', async () => {
		fs.writeFileSync(
			legacyPath(dir),
			`${JSON.stringify(record('sess_1', 1))}\n`,
			'utf-8',
		);
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('legacy-log');
		expect(health.activeCount).toBe(1);
		// Health is pure — it must not bootstrap the checkpoint.
		expect(fs.existsSync(checkpointPath(dir))).toBe(false);
	});

	test('checkpoint store reports sequence, age, and counts', async () => {
		// Frozen clock: the checkpoint's updatedAt and the health read share
		// one instant, so checkpointAgeMs is deterministic.
		const restore = freezeClock();
		try {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const health = await getPrSubscriptionHealth(dir);
			expect(health.recoverySource).toBe('checkpoint');
			expect(health.sequence).toBeGreaterThanOrEqual(1);
			expect(health.checkpointAgeMs).toBe(0);
			expect(health.activeCount).toBe(1);
			expect(health.checkpointBytes).toBeGreaterThan(0);
			expect(health.pressurePct).toBeGreaterThanOrEqual(0);
			expect(health.auditLimitBytes).toBeGreaterThan(0);
		} finally {
			restore();
		}
	});

	test('checkpoint + pending legacy tail reports checkpoint+legacy', async () => {
		const cp = baseCheckpoint(dir);
		cp.records['sess_1::o/r::1'] = record('sess_1', 1);
		cp.migration = {
			scannedBytes: 0,
			sourceBytes: 100,
			sourceMtimeMs: Date.now(),
			corruptLines: 0,
			done: false,
			archived: false,
			startedAt: Date.now(),
		};
		fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
		fs.writeFileSync(
			legacyPath(dir),
			`${JSON.stringify(record('sess_2', 2))}\n`,
			'utf-8',
		);
		const health = await getPrSubscriptionHealth(dir);
		expect(health.recoverySource).toBe('checkpoint+legacy');
		expect(health.activeCount).toBe(2);
	});

	describe('copied-state safety (foreign checkpoint)', () => {
		test('reads see nothing — the wrong monitor never starts', async () => {
			const cp = baseCheckpoint(dir);
			cp.rootPath = path.resolve(dir, '..', 'somewhere-else');
			cp.records['sess_1::o/r::1'] = record('sess_1', 1);
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');

			const active = await listActive(dir);
			expect(active).toHaveLength(0);
			const found = await lookupByPr(dir, 'o/r', 1);
			expect(found).toBeNull();
			const health = await getPrSubscriptionHealth(dir);
			expect(health.recoverySource).toBe('foreign');
			expect(health.activeCount).toBe(0);
			// The foreign checkpoint is untouched by reads.
			expect(fs.existsSync(checkpointPath(dir))).toBe(true);
		});

		test('the first write rebinds and quarantines the foreign checkpoint', async () => {
			const cp = baseCheckpoint(dir);
			cp.rootPath = path.resolve(dir, '..', 'somewhere-else');
			cp.records['sess_1::o/r::1'] = record('sess_1', 1);
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');

			await subscribe(dir, {
				sessionID: 'sess_local',
				prNumber: 5,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/5',
			});

			const foreignSlot = path.join(
				dir,
				'.swarm',
				'pr-monitor',
				'subscriptions.checkpoint.foreign.json',
			);
			expect(fs.existsSync(foreignSlot)).toBe(true);
			const quarantined: PrSubscriptionCheckpoint = JSON.parse(
				fs.readFileSync(foreignSlot, 'utf-8'),
			);
			expect(quarantined.rootPath).toBe(cp.rootPath);

			const rebound: PrSubscriptionCheckpoint = JSON.parse(
				fs.readFileSync(checkpointPath(dir), 'utf-8'),
			);
			expect(rebound.rootPath).toBe(path.resolve(dir));
			expect(rebound.records['sess_local::o/r::5']).toBeDefined();
			expect(rebound.records['sess_1::o/r::1']).toBeUndefined(); // foreign state not adopted
			expect(rebound.maintenance.resets).toBe(1);

			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			expect(active[0].sessionID).toBe('sess_local');
		});

		test('case differences in rootPath: same project on win32, foreign on POSIX', async () => {
			const cp = baseCheckpoint(dir);
			const resolved = path.resolve(dir);
			// Flip the case of the first cased letter (temp paths contain
			// letters on every CI platform).
			const flipAt = resolved.search(/[a-zA-Z]/);
			expect(flipAt).toBeGreaterThanOrEqual(0);
			const letter = resolved[flipAt];
			const flippedLetter =
				letter === letter.toLowerCase()
					? letter.toUpperCase()
					: letter.toLowerCase();
			cp.rootPath =
				resolved.slice(0, flipAt) + flippedLetter + resolved.slice(flipAt + 1);
			cp.records['sess_1::o/r::1'] = record('sess_1', 1);
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			const active = await listActive(dir);
			if (process.platform === 'win32') {
				expect(active).toHaveLength(1); // case-insensitive — same project
			} else {
				expect(active).toHaveLength(0); // case-sensitive — foreign
			}
		});
	});

	describe('corrupt-checkpoint quarantine + legacy recovery', () => {
		test('a checkpoint record whose identity does not compose is rejected on replay', async () => {
			const cp = baseCheckpoint(dir);
			// Structurally valid record whose correlationId disagrees with its parts.
			const bad = record('sess_1', 1);
			bad.correlationId = 'someone-else::o/r::1';
			cp.records[bad.correlationId] = bad;
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			const active = await listActive(dir);
			expect(active).toHaveLength(0); // identity-invalid monitor never exposed
			const health = await getPrSubscriptionHealth(dir);
			expect(health.recoverySource).toBe('corrupt-recovered');
		});

		test('a checkpoint whose map key disagrees with the record correlationId is rejected', async () => {
			const cp = baseCheckpoint(dir);
			const rec = record('sess_1', 1);
			cp.records['not-the-record-key'] = rec;
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			const active = await listActive(dir);
			expect(active).toHaveLength(0);
			expect((await getPrSubscriptionHealth(dir)).recoverySource).toBe(
				'corrupt-recovered',
			);
		});

		test('an oversized checkpoint (records over the guard) is rejected without loading', async () => {
			const cp = baseCheckpoint(dir);
			for (let i = 1; i <= 513; i++) {
				const rec = record(`sess_${i}`, i);
				cp.records[rec.correlationId] = rec;
			}
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			const active = await listActive(dir);
			expect(active).toHaveLength(0);
			expect((await getPrSubscriptionHealth(dir)).recoverySource).toBe(
				'corrupt-recovered',
			);
		});

		test('a checkpoint over the hard read byte ceiling is rejected before reading it', async () => {
			const cp = baseCheckpoint(dir);
			const rec = record('sess_1', 1);
			// One structurally valid record padded past the 1 MiB read ceiling.
			rec.lastCheckRunSet = 'x'.repeat(1_100_000);
			cp.records[rec.correlationId] = rec;
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			expect(fs.statSync(checkpointPath(dir)).size).toBeGreaterThan(
				1_024 * 1_024,
			);
			const active = await listActive(dir);
			expect(active).toHaveLength(0);
			expect((await getPrSubscriptionHealth(dir)).recoverySource).toBe(
				'corrupt-recovered',
			);
		});

		test('an unknown checkpoint schemaVersion is rejected as invalid (old-schema fails safe)', async () => {
			const cp = baseCheckpoint(dir);
			(cp as unknown as { schemaVersion: number }).schemaVersion = 99;
			cp.records['sess_1::o/r::1'] = record('sess_1', 1);
			fs.writeFileSync(checkpointPath(dir), `${JSON.stringify(cp)}\n`, 'utf-8');
			const health = await getPrSubscriptionHealth(dir);
			expect(health.recoverySource).toBe('corrupt-recovered');
			expect(health.activeCount).toBe(0); // no legacy to recover from
		});

		test('reads recover from the legacy log without throwing', async () => {
			fs.writeFileSync(checkpointPath(dir), '{not json', 'utf-8');
			fs.writeFileSync(
				legacyPath(dir),
				`${JSON.stringify(record('sess_1', 1))}\n`,
				'utf-8',
			);
			const active = await listActive(dir);
			expect(active).toHaveLength(1);
			const health = await getPrSubscriptionHealth(dir);
			expect(health.recoverySource).toBe('corrupt-recovered');
		});

		test('the next write quarantines the corrupt file to a single slot', async () => {
			fs.writeFileSync(checkpointPath(dir), '{not json', 'utf-8');
			fs.writeFileSync(
				legacyPath(dir),
				`${JSON.stringify(record('sess_1', 1))}\n`,
				'utf-8',
			);

			await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 2 });

			const corruptSlot = path.join(
				dir,
				'.swarm',
				'pr-monitor',
				'subscriptions.checkpoint.corrupt.json',
			);
			expect(fs.existsSync(corruptSlot)).toBe(true);
			expect(fs.readFileSync(corruptSlot, 'utf-8')).toBe('{not json');
			const cp: PrSubscriptionCheckpoint = JSON.parse(
				fs.readFileSync(checkpointPath(dir), 'utf-8'),
			);
			expect(cp.records['sess_1::o/r::1'].errorCount).toBe(2);
			expect(cp.maintenance.resets).toBe(1);
		});
	});

	describe('telemetry emission', () => {
		test('compaction and lifecycle triggers emit pr_subscription_health (counts only)', async () => {
			const savedEmit = telemetryInternals.emit;
			const emissions: Array<{
				kind: string;
				payload: Record<string, unknown>;
			}> = [];
			telemetryInternals.emit = ((
				kind: string,
				payload: Record<string, unknown>,
			) => {
				if (kind === 'pr_subscription_health')
					emissions.push({ kind, payload });
			}) as unknown as typeof savedEmit;
			try {
				// Trigger migrate-complete + archive via a legacy-seeded write op.
				fs.writeFileSync(
					legacyPath(dir),
					`${JSON.stringify(record('sess_1', 1))}\n`,
					'utf-8',
				);
				await updateSnapshot(dir, 'sess_1::o/r::1', { errorCount: 1 });
				// Trigger a terminal compaction via seeded terminal pressure.
				const cp: PrSubscriptionCheckpoint = JSON.parse(
					fs.readFileSync(checkpointPath(dir), 'utf-8'),
				);
				for (let i = 2; i <= 70; i++) {
					const rec = record('sess_t', i, Date.now() - 1000);
					rec.status = 'expired';
					rec.isWatching = false;
					cp.records[rec.correlationId] = rec;
				}
				fs.writeFileSync(
					checkpointPath(dir),
					`${JSON.stringify(cp)}\n`,
					'utf-8',
				);
				await unsubscribe(dir, 'sess_1::o/r::1');
			} finally {
				telemetryInternals.emit = savedEmit;
			}

			const triggers = emissions.map((e) => e.payload.trigger);
			expect(triggers).toContain('migrate-complete');
			expect(triggers).toContain('archive');
			expect(triggers).toContain('compact');
			// Counts-only payload contract: no correlationIds, no paths.
			const payload = emissions[0].payload as Record<string, unknown>;
			expect(payload.active_count).toBeDefined();
			expect(payload.correlationId).toBeUndefined();
			expect(JSON.stringify(payload)).not.toContain('o/r');
		});
	});

	describe('/swarm pr status storage footer', () => {
		afterEach(() => {
			// The status seam is module-global; restore defensively.
			statusInternals.getPrSubscriptionHealth = getPrSubscriptionHealth;
		});

		test('footer renders bounded-store health on the no-subscriptions path', async () => {
			const result = await handlePrMonitorStatusCommand(dir, [], 'sess_1');
			expect(result).toContain('No active PR subscriptions');
			expect(result).toContain('Storage:');
			expect(result).toContain('source empty');
		});

		test('footer renders on the populated path with checkpoint figures', async () => {
			await subscribe(dir, {
				sessionID: 'sess_1',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			// Avoid the gh CLI in tests: stub the merge-group runner.
			const savedRunner = statusInternals.listMergeGroupRuns;
			statusInternals.listMergeGroupRuns = (() =>
				Promise.resolve({ runs: [] })) as typeof savedRunner;
			try {
				const result = await handlePrMonitorStatusCommand(dir, [], 'sess_1');
				expect(result).toContain('o/r#1');
				expect(result).toContain('Storage:');
				expect(result).toContain('source checkpoint');
				expect(result).toContain('active 1');
				// Field-anchored patterns pin the footer's segment structure, not
				// just substrings — a swapped or dropped segment fails here.
				expect(result).toMatch(/checkpoint seq \d+ \(/);
				expect(result).toMatch(/active 1 · removed \d+ · expired \d+/);
				expect(result).toMatch(/store \d+\/\d+ B \([\d.]+%\)/);
				expect(result).toMatch(/audit \d+ lines/);
				expect(result).toMatch(
					/compactions \d+ · corrupt \d+ · dropped-audit \d+/,
				);
				expect(result).toMatch(/resets \d+/);
			} finally {
				statusInternals.listMergeGroupRuns = savedRunner;
			}
		});

		test('footer warns when a legacy source exceeds the fold budget', async () => {
			const legacy = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			fs.writeFileSync(legacy, '', 'utf-8');
			fs.truncateSync(legacy, PR_SUBSCRIPTION_LIMITS.legacySourceMaxBytes + 1);
			const result = await handlePrMonitorStatusCommand(dir, [], 'sess_1');
			expect(result).toContain('Storage:');
			expect(result).toContain('exceeds the migration size limit');
		});

		test('footer is omitted when health fails', async () => {
			const savedHealth = statusInternals.getPrSubscriptionHealth;
			statusInternals.getPrSubscriptionHealth = (() =>
				Promise.reject(new Error('boom'))) as typeof savedHealth;
			try {
				const result = await handlePrMonitorStatusCommand(dir, [], 'sess_1');
				expect(result).not.toContain('Storage:');
				expect(result).toContain('No active PR subscriptions');
			} finally {
				statusInternals.getPrSubscriptionHealth = savedHealth;
			}
		});
	});
});
