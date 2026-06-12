/**
 * Tests for insight-candidates.jsonl FIFO cap (#1234 Part 3C).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

describe('insight candidates FIFO cap', () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cap-'));
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('exports the expected max entries constant', () => {
		expect(INSIGHT_CANDIDATES_MAX_ENTRIES).toBe(500);
	});

	it('resolves the correct path', () => {
		const p = resolveInsightCandidatesPath(dir);
		expect(p).toContain('.swarm');
		expect(p).toContain('insight-candidates.jsonl');
	});

	it('caps the file at INSIGHT_CANDIDATES_MAX_ENTRIES via FIFO', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });

		const seedCount = INSIGHT_CANDIDATES_MAX_ENTRIES + 10;
		const lines: string[] = [];
		for (let i = 0; i < seedCount; i++) {
			lines.push(JSON.stringify(makeCandidate(i)));
		}
		fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf-8');

		const lineCountBefore = fs
			.readFileSync(filePath, 'utf-8')
			.split('\n')
			.filter(Boolean).length;
		expect(lineCountBefore).toBe(seedCount);

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

		const afterContent = fs.readFileSync(filePath, 'utf-8');
		const afterLines = afterContent.split('\n').filter(Boolean);
		expect(afterLines.length).toBeLessThanOrEqual(
			INSIGHT_CANDIDATES_MAX_ENTRIES,
		);

		const lastEntry = JSON.parse(afterLines[afterLines.length - 1]);
		expect(lastEntry.source.kind).toBe('micro_reflection');
	});

	it('preserves most recent entries when capping', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });

		const seedCount = INSIGHT_CANDIDATES_MAX_ENTRIES;
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

		const afterLines = fs
			.readFileSync(filePath, 'utf-8')
			.split('\n')
			.filter(Boolean);
		expect(afterLines.length).toBeLessThanOrEqual(
			INSIGHT_CANDIDATES_MAX_ENTRIES,
		);

		const firstEntry = JSON.parse(afterLines[0]);
		expect(firstEntry.lesson).not.toContain('number 0');
	});

	it('handles corrupt existing content gracefully', async () => {
		const filePath = resolveInsightCandidatesPath(dir);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
		const afterLines = fs
			.readFileSync(filePath, 'utf-8')
			.split('\n')
			.filter(Boolean);
		for (const line of afterLines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
	});
});
