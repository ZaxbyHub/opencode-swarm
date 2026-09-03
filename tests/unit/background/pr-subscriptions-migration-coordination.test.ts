import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	PR_SUBSCRIPTIONS_FILE,
	getPrSubscriptionHealth,
	listActive,
	subscribe,
	type PrSubscriptionCheckpoint,
} from '../../../src/background/pr-subscriptions';
import { closeProjectDb } from '../../../src/db/project-db.js';
import { freezeClock } from '../../helpers/test-clock';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function record(sessionID: string, prNumber: number) {
	const now = 1_700_000_000_000;
	return {
		correlationId: `${sessionID}::o/r::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		lastCheckedAt: now,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active' as const,
		createdAt: now,
		updatedAt: now,
		errorCount: 0,
	};
}

describe('PR subscription reads during SQLite migration', () => {
	let dir: string;

	beforeEach(() => {
		dir = canonicalMkdtemp('pr-sub-migration-coordination-');
		fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), { recursive: true });
	});

	afterEach(() => {
		closeProjectDb(dir);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('overlays a legacy tail when SQLite already has a partial migration prefix', async () => {
		const restore = freezeClock({ fixedNow: 1_700_000_000_000 });
		try {
			const prefix = await subscribe(dir, {
				sessionID: 'prefix',
				prNumber: 1,
				repoFullName: 'o/r',
				prUrl: 'https://github.com/o/r/pull/1',
			});
			const legacyPath = path.join(dir, '.swarm', PR_SUBSCRIPTIONS_FILE);
			fs.writeFileSync(legacyPath, `${JSON.stringify(prefix)}\n`, 'utf8');
			const source = fs.statSync(legacyPath);
			const checkpointPath = path.join(
				dir,
				'.swarm',
				PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
			);
			const checkpoint = JSON.parse(
				fs.readFileSync(checkpointPath, 'utf8'),
			) as PrSubscriptionCheckpoint;
			checkpoint.migration = {
				scannedBytes: source.size,
				sourceBytes: source.size,
				sourceMtimeMs: source.mtimeMs,
				corruptLines: 0,
				done: false,
				archived: false,
				startedAt: checkpoint.updatedAt,
				baselineRecords: { [prefix.correlationId]: prefix },
				baselineTerminalSummary: checkpoint.terminalSummary,
			};
			fs.writeFileSync(
				checkpointPath,
				`${JSON.stringify(checkpoint)}\n`,
				'utf8',
			);

			const tail = record('tail', 2);
			fs.appendFileSync(legacyPath, `${JSON.stringify(tail)}\n`, 'utf8');

			const active = await listActive(dir);
			expect(active.map((entry) => entry.correlationId).sort()).toEqual(
				[prefix.correlationId, tail.correlationId].sort(),
			);
			const health = await getPrSubscriptionHealth(dir);
			expect(health.activeCount).toBe(2);
			expect(health.recoverySource).toBe('checkpoint+legacy');
		} finally {
			restore();
		}
	});
});
