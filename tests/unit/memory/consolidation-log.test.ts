import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
	appendConsolidationLog,
	type ConsolidationLogRecord,
	readConsolidationLog,
} from '../../../src/memory/consolidation-log';

let dir: string;

function record(phaseNumber: number): ConsolidationLogRecord {
	return {
		phaseNumber,
		startedAt: '2026-06-23T00:00:00.000Z',
		completedAt: '2026-06-23T00:01:00.000Z',
		clusterCount: 2,
		clustersDeferred: 0,
		decisionsEmitted: 1,
		added: 1,
		superseded: 0,
		contradictionsDetected: 0,
		deduped: 0,
		proposed: 0,
		memoriesDecayed: 3,
		skipped: 0,
		processedProposalIds: ['prop_aaaaaaaaaaaaaaaa'],
	};
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'consol-log-')));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('consolidation-log persistence', () => {
	test('returns [] when no log exists yet', async () => {
		expect(await readConsolidationLog(dir)).toEqual([]);
	});

	test('round-trips appended records in order', async () => {
		await appendConsolidationLog(dir, record(1));
		await appendConsolidationLog(dir, record(2));
		const all = await readConsolidationLog(dir);
		expect(all.map((r) => r.phaseNumber)).toEqual([1, 2]);
		expect(all[0].memoriesDecayed).toBe(3);
	});

	test('skips corrupt lines without throwing', async () => {
		await appendConsolidationLog(dir, record(1));
		// Manually corrupt by appending a bad line via the same file path.
		const { appendFileSync } = await import('node:fs');
		appendFileSync(
			path.join(dir, '.swarm', 'memory', 'consolidation-log.jsonl'),
			'not json\n',
		);
		await appendConsolidationLog(dir, record(2));
		const all = await readConsolidationLog(dir);
		expect(all.map((r) => r.phaseNumber)).toEqual([1, 2]);
	});
});
