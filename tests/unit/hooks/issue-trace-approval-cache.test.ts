/**
 * Approval-cache invalidation for SQLite-authoritative plan ledgers (#2484).
 *
 * Uses the issue-trace `_internals` seam so the test exercises the cache
 * fingerprint without creating a project database or driving the full hook.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { _internals, resetApprovalCache } from '../../../src/hooks/issue-trace';
import type { PlanLedgerState } from '../../../src/plan/ledger-sqlite';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const originals = { ..._internals };

function makeTempDir(): string {
	const directory = canonicalMkdtemp('issue-trace-cache-');
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

function sqliteState(lastSeq: number, lastEventHash: string): PlanLedgerState {
	return {
		id: 1,
		authorityMode: 'sqlite',
		shadowStartedVersion: null,
		parityStatus: 'clean',
		fileReplayHash: null,
		sqliteReplayHash: null,
		terminalProjectionHash: 'projection',
		lastSeq,
		lastEventHash,
		rootEventHash: null,
		planId: 'plan',
		planEpoch: null,
		terminalPlanHash: null,
		terminalProjection: null,
		terminalProjectionJson: null,
		terminalMetadata: null,
		updatedAt: `2026-09-06T00:00:0${lastSeq}Z`,
		authority_mode: 'sqlite',
		shadow_started_version: null,
		parity_status: 'clean',
		file_replay_hash: null,
		sqlite_replay_hash: null,
		terminal_projection_hash: 'projection',
		last_seq: lastSeq,
	};
}

afterEach(() => {
	Object.assign(_internals, originals);
	resetApprovalCache();
});

describe('issue-trace approval cache', () => {
	test('SQLite state revision invalidates a same-size stale JSONL result', async () => {
		const directory = makeTempDir();
		const ledgerPath = path.join(directory, '.swarm', 'plan-ledger.jsonl');
		fs.writeFileSync(ledgerPath, 'stale portable export', 'utf-8');

		let approvalCalls = 0;
		let approved = false;
		let state = sqliteState(1, 'event-old');
		_internals.isPlanCriticApproved = async () => {
			approvalCalls += 1;
			return approved;
		};
		_internals.getPlanLedgerState = () => state;

		const first = await _internals.boundedApprovalCheck(directory, 100);
		expect(first).toBe(false);
		expect(approvalCalls).toBe(1);

		// The failed portable export leaves JSONL byte-for-byte unchanged, while
		// the committed SQLite authority advances to a new event revision.
		approved = true;
		state = sqliteState(2, 'event-new');
		const second = await _internals.boundedApprovalCheck(directory, 100);
		expect(second).toBe(true);
		expect(approvalCalls).toBe(2);
		expect(fs.statSync(ledgerPath).size).toBe('stale portable export'.length);
	});

	test('file-shadow projects retain size+mtime cache behavior', async () => {
		const directory = makeTempDir();
		const ledgerPath = path.join(directory, '.swarm', 'plan-ledger.jsonl');
		fs.writeFileSync(ledgerPath, 'portable export', 'utf-8');

		let approvalCalls = 0;
		let approved = false;
		_internals.isPlanCriticApproved = async () => {
			approvalCalls += 1;
			return approved;
		};
		_internals.getPlanLedgerState = () =>
			({ authorityMode: 'file_shadow' }) as PlanLedgerState;

		expect(await _internals.boundedApprovalCheck(directory, 100)).toBe(false);
		approved = true;
		expect(await _internals.boundedApprovalCheck(directory, 100)).toBe(false);
		expect(approvalCalls).toBe(1);

		const nextMtime = new Date(Date.now() + 2_000);
		fs.utimesSync(ledgerPath, nextMtime, nextMtime);
		expect(await _internals.boundedApprovalCheck(directory, 100)).toBe(true);
		expect(approvalCalls).toBe(2);
	});
});
