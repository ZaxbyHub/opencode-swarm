import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { handleMemoryConsolidationLogCommand } from '../../../src/commands/memory';
import {
	appendConsolidationLog,
	type ConsolidationLogRecord,
} from '../../../src/memory/consolidation-log';

let dir: string;

function record(phaseNumber: number): ConsolidationLogRecord {
	return {
		phaseNumber,
		startedAt: '2026-06-23T00:00:00.000Z',
		completedAt: `2026-06-23T00:0${phaseNumber}:00.000Z`,
		clusterCount: 2,
		clustersDeferred: 1,
		decisionsEmitted: 2,
		added: 1,
		superseded: 1,
		contradictionsDetected: 1,
		deduped: 3,
		proposed: 1,
		memoriesDecayed: 4,
		errored: 0,
		processedProposalIds: ['prop_aaaaaaaaaaaaaaaa', 'prop_bbbbbbbbbbbbbbbb'],
	};
}

beforeEach(() => {
	dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'consol-cli-')));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('/swarm memory consolidation-log', () => {
	test('reports an empty-state message when no passes recorded', async () => {
		const out = await handleMemoryConsolidationLogCommand(dir, []);
		expect(out).toContain('Consolidation Log');
		expect(out).toContain('No consolidation passes');
	});

	test('renders recent passes newest-first with metrics', async () => {
		await appendConsolidationLog(dir, record(1));
		await appendConsolidationLog(dir, record(2));
		const out = await handleMemoryConsolidationLogCommand(dir, []);
		expect(out).toContain('Total recorded passes: `2`');
		// Newest (phase 2) appears before phase 1.
		expect(out.indexOf('Phase 2')).toBeLessThan(out.indexOf('Phase 1'));
		expect(out).toContain('Contradictions: `1`');
		expect(out).toContain('Memories decayed: `4`');
	});

	test('respects --limit', async () => {
		await appendConsolidationLog(dir, record(1));
		await appendConsolidationLog(dir, record(2));
		await appendConsolidationLog(dir, record(3));
		const out = await handleMemoryConsolidationLogCommand(dir, [
			'--limit',
			'1',
		]);
		expect(out).toContain('Showing: `1`');
		expect(out).toContain('Phase 3');
		expect(out).not.toContain('Phase 1 —');
	});

	test('rejects malformed --limit with usage', async () => {
		const out = await handleMemoryConsolidationLogCommand(dir, [
			'--limit',
			'x',
		]);
		expect(out).toContain('Usage:');
	});
});
