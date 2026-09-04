/**
 * Issue #2042 — recovery-slot semantics for the PR-monitor subscription
 * checkpoint store: a second recovery event (foreign/corrupt quarantine)
 * must preserve the first event's displaced copy in a `.prev` slot instead
 * of destroying it, and the lifetime reset counter must be monotone.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	PR_SUBSCRIPTIONS_CHECKPOINT_FILE,
	type PrSubscriptionCheckpoint,
	type PrSubscriptionRecord,
	subscribe,
	updateSnapshot,
} from '../../../src/background/pr-subscriptions';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-pr-sub-rcv-');
	fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
		recursive: true,
	});
	return dir;
}

// Canonical-tmpdir helper import (FR-011).
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function checkpointPath(dir: string): string {
	return path.join(dir, '.swarm', PR_SUBSCRIPTIONS_CHECKPOINT_FILE);
}

// Fixed fixture stamp — these tests assert structure, not clock behavior.
const FIXTURE_NOW = 1_700_000_000_000;

function record(
	sessionID: string,
	prNumber: number,
	updatedAt = FIXTURE_NOW,
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

function foreignCheckpoint(
	rootSuffix: string,
	sessionID: string,
	pr: number,
	resets = 0,
) {
	const cp: PrSubscriptionCheckpoint = {
		schemaVersion: 1,
		sequence: 1,
		rootPath: path.resolve(dir(), '..', rootSuffix),
		updatedAt: FIXTURE_NOW,
		records: {},
		terminalSummary: { removed: 0, expired: 0, lastTerminalAt: null },
		migration: null,
		maintenance: {
			compactions: 0,
			droppedAuditTransitions: 0,
			corruptLegacyRecords: 0,
			lastCompactedAt: null,
			resets,
		},
	};
	const rec = record(sessionID, pr);
	cp.records[rec.correlationId] = rec;
	return cp;
}

// The temp directory for the current test (set in beforeEach).
let currentDir = '';
function dir(): string {
	return currentDir;
}

describe('pr-subscriptions recovery slots', () => {
	let dirPath: string;
	beforeEach(() => {
		dirPath = makeTempProject();
		currentDir = dirPath;
	});
	afterEach(() => {
		closeAllProjectDbs();
		fs.rmSync(dirPath, { recursive: true, force: true });
	});

	test('a second recovery event preserves the first quarantined copy in a .prev slot', async () => {
		// First recovery: foreign checkpoint (projB) quarantined, store rebound.
		fs.writeFileSync(
			checkpointPath(dirPath),
			`${JSON.stringify(foreignCheckpoint('projB', 'sess_1', 1))}\n`,
			'utf-8',
		);
		await subscribe(dirPath, {
			sessionID: 'sess_local',
			prNumber: 5,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/5',
		});
		const foreignSlot = path.join(
			dirPath,
			'.swarm',
			'pr-monitor',
			'subscriptions.checkpoint.foreign.json',
		);
		const prevSlot = `${foreignSlot}.prev`;
		expect(fs.existsSync(foreignSlot)).toBe(true);

		// Second recovery: the project moved AGAIN — a second foreign
		// checkpoint (projC) is quarantined. The first event's displaced copy
		// must survive in the .prev slot instead of being destroyed.
		// The live checkpoint at projB carries resets=1 from the FIRST rebind.
		fs.writeFileSync(
			checkpointPath(dirPath),
			`${JSON.stringify(foreignCheckpoint('projC', 'sess_9', 9, 1))}\n`,
			'utf-8',
		);
		await subscribe(dirPath, {
			sessionID: 'sess_local2',
			prNumber: 6,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/6',
		});

		expect(fs.existsSync(prevSlot)).toBe(true);
		const prev: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(prevSlot, 'utf-8'),
		);
		expect(prev.records['sess_1::o/r::1']).toBeDefined(); // first event preserved
		const current: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(foreignSlot, 'utf-8'),
		);
		expect(current.records['sess_9::o/r::9']).toBeDefined(); // second event quarantined
		const after: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dirPath), 'utf-8'),
		);
		// Lifetime reset counter: monotone across recovery generations.
		expect(after.maintenance.resets).toBe(2);
		expect(after.records['sess_local2::o/r::6']).toBeDefined();
	});

	test('reset carry-forward survives a subsequent compaction cycle', async () => {
		fs.writeFileSync(
			checkpointPath(dirPath),
			`${JSON.stringify(foreignCheckpoint('projB', 'sess_1', 1))}\n`,
			'utf-8',
		);
		await subscribe(dirPath, {
			sessionID: 'sess_local',
			prNumber: 5,
			repoFullName: 'o/r',
			prUrl: 'https://github.com/o/r/pull/5',
		});
		// Force a terminal compaction via seeded terminal pressure.
		const cp: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dirPath), 'utf-8'),
		);
		for (let i = 1; i <= 70; i++) {
			const rec = record('sess_t', i, FIXTURE_NOW - 1000);
			rec.status = 'expired';
			rec.isWatching = false;
			cp.records[rec.correlationId] = rec;
		}
		fs.writeFileSync(
			checkpointPath(dirPath),
			`${JSON.stringify(cp)}\n`,
			'utf-8',
		);
		await updateSnapshot(dirPath, 'sess_local::o/r::5', { errorCount: 3 });
		const after: PrSubscriptionCheckpoint = JSON.parse(
			fs.readFileSync(checkpointPath(dirPath), 'utf-8'),
		);
		// The carry-forward reset (1) is untouched by compaction counters.
		expect(after.maintenance.resets).toBe(1);
		expect(after.maintenance.compactions).toBe(1);
		expect(after.records['sess_local::o/r::5']).toBeDefined();
	});
});
