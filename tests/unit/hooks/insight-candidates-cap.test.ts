/**
 * Tests for the insight-candidates durable queue FIFO cap (#1234 Part 3C,
 * re-anchored to the swarm.db `insight_candidate` stream by #2480).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeGroupCommitWriter } from '../../../src/db/group-commit-writer.js';
import {
	_resetInsightImportGuards,
	countPendingInsightCandidatesDb,
	INSIGHT_CANDIDATE_STREAM_ID,
	INSIGHT_PENDING_CAP,
	listPendingInsightCandidatesDb,
} from '../../../src/db/insight-candidate-store.js';
import { closeProjectDb, getProjectDb } from '../../../src/db/project-db.js';
import {
	INSIGHT_CANDIDATES_MAX_ENTRIES,
	resolveInsightCandidatesPath,
	runMicroReflection,
} from '../../../src/hooks/micro-reflector.js';
import type { TrajectoryEntry } from '../../../src/hooks/trajectory-logger.js';

function makeCandidate(index: number): Record<string, unknown> {
	return {
		lesson: `Pre-existing lesson number ${index} that is long enough`,
		category: 'process',
		tags: [],
		applies_to_agents: ['coder'],
		required_actions: ['always run tests'],
		source: {
			kind: 'micro_reflection',
			agent: 'coder',
			outcome: 'failure_test',
			trajectory_steps: 3,
		},
		created_at: `2026-01-01T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
	};
}

function makeLLMResponse(): string {
	return JSON.stringify([
		{
			lesson: 'Always verify test assertions match expected output format',
			applies_to_agents: ['coder'],
			required_actions: ['check assertion format before committing'],
			category: 'testing',
		},
	]);
}

function makeFailureTrajectory(): TrajectoryEntry[] {
	return [
		{
			step: 1,
			agent: 'coder',
			action: 'edit',
			target: 'src/main.ts',
			intent: 'fix bug',
			timestamp: '2026-01-01T00:00:00.000Z',
			result: 'success',
			tool: 'edit',
			args_summary: '',
			verdict: '',
			elapsed_ms: 10,
		},
		{
			step: 2,
			agent: 'coder',
			action: 'run',
			target: '',
			intent: 'run tests',
			timestamp: '2026-01-01T00:00:01.000Z',
			result: 'failure',
			tool: 'test_runner',
			args_summary: '',
			verdict: '3 assertions failed',
			elapsed_ms: 500,
		},
	];
}

interface VersionRow {
	version: number;
	payload: string;
}

function pendingRows(directory: string): VersionRow[] {
	return getProjectDb(directory)
		.query<VersionRow, [string]>(
			`SELECT version, payload FROM insight_candidate
			WHERE stream_id = ? AND consumed_at IS NULL
			ORDER BY version`,
		)
		.all(INSIGHT_CANDIDATE_STREAM_ID);
}

describe('insight candidates FIFO cap (swarm.db store, #2480)', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cap-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		_resetInsightImportGuards();
	});

	afterEach(() => {
		try {
			closeGroupCommitWriter(dir);
			closeProjectDb(dir);
		} catch {
			// already closed
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('exports the expected max entries constant', () => {
		expect(INSIGHT_CANDIDATES_MAX_ENTRIES).toBe(500);
		expect(INSIGHT_PENDING_CAP).toBe(500);
	});

	it('resolves the legacy path (import surface)', () => {
		const p = resolveInsightCandidatesPath(dir);
		expect(p).toContain('.swarm');
		expect(p).toContain('insight-candidates.jsonl');
	});

	it('caps the pending queue at INSIGHT_PENDING_CAP via FIFO', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		const seedCount = INSIGHT_PENDING_CAP + 10;
		const lines: string[] = [];
		for (let i = 0; i < seedCount; i++) {
			lines.push(JSON.stringify(makeCandidate(i)));
		}
		fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

		const result = await runMicroReflection({
			directory: dir,
			agent: 'coder',
			transcript: 'test failed: 3 assertions failed',
			trajectory: makeFailureTrajectory(),
			llmDelegate: async () => makeLLMResponse(),
			quota: { maxCalls: 100, window: 'utc' },
		});

		expect(result.outcome).toBe('failure_test');
		expect(result.reflected).toBe(true);

		const rows = pendingRows(dir);
		expect(rows.length).toBeLessThanOrEqual(INSIGHT_PENDING_CAP);

		const lastEntry = JSON.parse(rows[rows.length - 1].payload);
		expect(lastEntry.source.kind).toBe('micro_reflection');
	});

	it('preserves most recent entries when capping', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		const seedCount = INSIGHT_PENDING_CAP;
		const lines: string[] = [];
		for (let i = 0; i < seedCount; i++) {
			lines.push(JSON.stringify(makeCandidate(i)));
		}
		fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

		await runMicroReflection({
			directory: dir,
			agent: 'coder',
			transcript: 'test failed: 3 assertions failed',
			trajectory: makeFailureTrajectory(),
			llmDelegate: async () => makeLLMResponse(),
			quota: { maxCalls: 100, window: 'utc' },
		});

		const rows = pendingRows(dir);
		expect(rows.length).toBeLessThanOrEqual(INSIGHT_PENDING_CAP);

		const firstEntry = JSON.parse(rows[0].payload);
		expect(firstEntry.lesson).not.toContain('number 0');
	});

	it('handles corrupt existing content gracefully', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		fs.writeFileSync(
			filePath,
			'not valid json\n{broken\n' + JSON.stringify(makeCandidate(999)) + '\n',
			'utf-8',
		);

		const result = await runMicroReflection({
			directory: dir,
			agent: 'coder',
			transcript: 'test failed: 3 assertions failed',
			trajectory: makeFailureTrajectory(),
			llmDelegate: async () => makeLLMResponse(),
			quota: { maxCalls: 100, window: 'utc' },
		});

		expect(result.reflected).toBe(true);
		// The corrupt lines were skipped at import; every durable row parses.
		for (const row of pendingRows(dir)) {
			expect(() => JSON.parse(row.payload)).not.toThrow();
		}
		expect(countPendingInsightCandidatesDb(dir)).toBe(2); // 1 valid seed + 1 fresh
		expect(listPendingInsightCandidatesDb(dir, 10).length).toBe(2);
	});
});
