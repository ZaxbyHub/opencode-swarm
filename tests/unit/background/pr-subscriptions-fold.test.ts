/**
 * Issue #2042 — foldLegacyRegion mechanics (blocker-2 regression class):
 * oversize lines are skipped and counted without parsing, and I/O failures
 * surface as `aborted` so callers never treat a partial scan as complete.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	getPrSubscriptionHealth,
	listActive,
	PR_SUBSCRIPTION_LIMITS,
	type PrSubscriptionRecord,
} from '../../../src/background/pr-subscriptions';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

// Fixed fixture stamp — these tests assert structure, not clock behavior.
const FIXTURE_NOW = 1_700_000_000_000;

function record(sessionID: string, prNumber: number): PrSubscriptionRecord {
	const now = FIXTURE_NOW;
	return {
		correlationId: `${sessionID}::o/r::${prNumber}`,
		sessionID,
		prNumber,
		repoFullName: 'o/r',
		prUrl: `https://github.com/o/r/pull/${prNumber}`,
		lastCheckedAt: now,
		isWatching: true,
		hasUnaddressedEvents: false,
		status: 'active',
		createdAt: now,
		updatedAt: now,
		errorCount: 0,
	};
}

describe('foldLegacyRegion mechanics', () => {
	let dir: string;
	beforeEach(() => {
		dir = canonicalMkdtemp('swarm-pr-sub-fold-');
		fs.mkdirSync(path.join(dir, '.swarm', 'pr-monitor'), {
			recursive: true,
		});
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	function legacyPath(): string {
		return path.join(dir, '.swarm', 'pr-monitor', 'subscriptions.jsonl');
	}

	test('an oversize legacy line (>64 KiB) is skipped and counted, never parsed', async () => {
		const good = record('sess_good', 1);
		// 65615-byte line — over the 65536-byte maxRecordBytes bound.
		const oversize = `{"padding":"${'x'.repeat(65_600)}"}`;
		expect(Buffer.byteLength(oversize, 'utf-8')).toBeGreaterThan(
			PR_SUBSCRIPTION_LIMITS.maxRecordBytes,
		);
		fs.writeFileSync(
			legacyPath(),
			[`${JSON.stringify(good)}\n`, `${oversize}\n`].join(''),
			'utf-8',
		);

		const active = await listActive(dir);
		expect(active).toHaveLength(1);
		expect(active[0].sessionID).toBe('sess_good');

		const health = await getPrSubscriptionHealth(dir);
		expect(health.corruptLegacyRecords).toBe(1);
	});

	test('foldLegacyRegion flags an I/O failure as aborted, not eof (blocker-2 regression)', () => {
		// Folding a nonexistent path forces openSync to throw (ENOENT — the
		// same transient-I/O failure class as EBUSY/EPERM) — the abort path
		// must surface as aborted:true so callers never treat it as a
		// complete scan.
		const result = _internals.foldLegacyRegion(
			path.join(dir, '.swarm', 'pr-monitor', 'does-not-exist.jsonl'),
			0,
			Number.MAX_SAFE_INTEGER,
		);
		expect(result.aborted).toBe(true);
		expect(result.eof).toBe(true);
		expect(result.folded.size).toBe(0);
		expect(result.nextByte).toBe(0);
	});
});
