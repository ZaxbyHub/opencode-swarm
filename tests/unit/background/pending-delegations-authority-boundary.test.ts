import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_FILE,
	compactBackgroundDelegations,
	readDelegations,
	recordPendingDelegationDetailed,
	reserveBackgroundCoderSlot,
	scanBackgroundCoderReservationsForAdmission,
} from '../../../src/background/pending-delegations';
import { closeAllProjectDbs, getProjectDb } from '../../../src/db/project-db';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-authority-');

beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	closeAllProjectDbs();
	cleanup();
});

describe('pending-delegations SQLite authority boundary', () => {
	test('refuses compaction when a present authority row is unreadable', async () => {
		const ledgerPath = path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
		fs.writeFileSync(ledgerPath, 'legacy-data-that-must-not-be-used\n');
		// Bypass the transition validator to model on-disk corruption discovered
		// during a read; normal writes reject malformed JSON before it reaches SQL.
		getProjectDb(dir).run(
			`INSERT INTO coordination_state
				(namespace, entity_key, revision, generation, status, payload, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				'background.pending-delegation',
				'damaged',
				1,
				1,
				'completed',
				'not-json',
				'2026-01-01T00:00:00.000Z',
			],
		);

		const result = await compactBackgroundDelegations(dir, { force: true });

		expect(result.status).toBe('uncertain');
		expect(result.reason).toContain('refusing legacy compaction fallback');
		expect(fs.readFileSync(ledgerPath, 'utf8')).toBe(
			'legacy-data-that-must-not-be-used\n',
		);
	});

	test('rejects a valid delegation payload bound to the wrong SQLite entity key', async () => {
		expect(
			(
				await recordPendingDelegationDetailed(dir, {
					correlationId: 'delegation-real',
					jobId: null,
					subagentSessionId: 'delegation-real',
					parentSessionId: 'parent',
					callID: 'call',
					normalizedAgent: 'reviewer',
					swarmPrefixedAgent: 'reviewer',
					planTaskId: null,
					evidenceTaskId: null,
				})
			).status,
		).toBe('recorded');
		getProjectDb(dir).run(
			`UPDATE coordination_state SET entity_key = ?
			 WHERE namespace = ? AND entity_key = ?`,
			['delegation-wrong', 'background.pending-delegation', 'delegation-real'],
		);

		expect(readDelegations(dir)).toEqual([]);
	});

	test('treats a reservation payload bound to the wrong SQLite key as uncertain', async () => {
		const reserved = await reserveBackgroundCoderSlot(dir, {
			parentSessionId: 'parent',
			planTaskId: '1.1',
			callID: 'call-reservation',
			maxConcurrent: 2,
		});
		expect(reserved.ok).toBe(true);
		if (!reserved.ok) throw new Error(reserved.detail);
		getProjectDb(dir).run(
			`UPDATE coordination_state SET entity_key = ?
			 WHERE namespace = ? AND entity_key = ?`,
			[
				'reservation-wrong',
				'background.coder-reservation',
				reserved.reservation.reservationId,
			],
		);

		expect(scanBackgroundCoderReservationsForAdmission(dir).status).toBe(
			'uncertain',
		);
	});
});
