import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	auditCrossContamination,
	buildPairCommand,
	evaluatePairResult,
	lastLines,
	PAIRS,
	readPassCount,
} from '../../../scripts/check-cross-contamination';

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../..',
);

describe('check-cross-contamination — parsing helpers', () => {
	test('readPassCount extracts the pass count from Bun output', () => {
		expect(readPassCount('  71 pass\n  2 fail\n')).toBe(71);
	});

	test('readPassCount returns 0 for malformed or missing output', () => {
		expect(readPassCount('FAIL no summary line')).toBe(0);
	});

	test('lastLines returns only the requested tail', () => {
		expect(lastLines('a\nb\nc\nd\n', 2)).toBe('c\nd');
	});

	test('buildPairCommand uses the provided runtime path and timeout', () => {
		expect(buildPairCommand('C:/tools/bun.exe', PAIRS[0], 4321)).toEqual([
			'C:/tools/bun.exe',
			'--smol',
			'test',
			PAIRS[0].fileA,
			PAIRS[0].fileB,
			'--timeout',
			'4321',
		]);
	});
});

describe('check-cross-contamination — pair result classification', () => {
	const cleanPair = PAIRS[0];
	const knownPair = PAIRS[1];

	test('keeps the pair order and records explicit floors/outcomes', () => {
		expect(PAIRS.map(({ fileA, fileB }) => [fileA, fileB])).toEqual([
			[
				'tests/unit/diff/ast-diff.test.ts',
				'src/hooks/__tests__/semantic-diff-injection.test.ts',
			],
			[
				'tests/unit/hooks/knowledge-reader.test.ts',
				'tests/unit/services/skill-generator.test.ts',
			],
		]);
		expect(cleanPair).toMatchObject({
			minimumPasses: 57,
			allowedOutcome: 'clean',
		});
		expect(knownPair).toMatchObject({
			minimumPasses: 71,
			allowedOutcome: 'known_shared_process',
		});
	});

	test('classifies an exit-0 co-run as clean', () => {
		const result = evaluatePairResult(cleanPair, {
			exitCode: 0,
			stdout: '57 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('clean');
		expect(result.messages).toEqual([]);
		expect(result.actualPasses).toBe(57);
		expect(result.minimumPasses).toBe(57);
	});

	test('treats a non-zero clean-pair exit at the floor as unexpected', () => {
		const result = evaluatePairResult(cleanPair, {
			exitCode: 1,
			stdout: '57 pass\n',
			stderr: 'AssertionError: unrelated failure\n',
		});
		expect(result.kind).toBe('regression_unexpected_failure');
		expect(result.messages.join('\n')).toContain(
			'Unexpected test failure or process error introduced',
		);
	});

	test('classifies a knowledge-pair floor result as an allowed known issue', () => {
		const result = evaluatePairResult(knownPair, {
			exitCode: 1,
			stdout: ' 71 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('known_issue');
		expect(result.actualPasses).toBe(71);
		expect(result.messages.join('\n')).toContain('per-file CI isolation');
		expect(result.messages.join('\n')).toContain(
			'CI runs each discovered unit file in its own process',
		);
	});

	test('permits the known knowledge-pair outcome above the floor', () => {
		const result = evaluatePairResult(knownPair, {
			exitCode: 1,
			stdout: '99 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('known_issue');
	});

	test('fails a knowledge-pair result below the floor', () => {
		const result = evaluatePairResult(knownPair, {
			exitCode: 1,
			stdout: '70 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('regression_pass_drop');
		expect(result.actualPasses).toBe(70);
	});

	test('treats malformed combined output as a regression with zero passes', () => {
		const result = evaluatePairResult(knownPair, {
			exitCode: 1,
			stdout: '',
			stderr: 'FAIL without summary line\n',
		});
		expect(result.kind).toBe('regression_pass_drop');
		expect(result.actualPasses).toBe(0);
	});
});

describe('check-cross-contamination — main audit wiring', () => {
	test('resolves the repo root from a nested start directory before running pairs', async () => {
		const nestedStartDir = path.join(REPO_ROOT, 'tests', 'unit', 'scripts');
		const seenRoots: string[] = [];
		const summary = await auditCrossContamination(nestedStartDir, {
			runPair: (repoRoot) => {
				seenRoots.push(repoRoot);
				return { exitCode: 0, stdout: '', stderr: '' };
			},
		});

		expect(summary.exitCode).toBe(0);
		expect(seenRoots).toEqual([REPO_ROOT, REPO_ROOT]);
		expect(summary.repoRoot).toBe(REPO_ROOT);
		expect(summary.messages).toEqual([
			'No cross-contamination detected: all test pairs pass when co-run.',
		]);
	});

	test('does not emit hook coverage warnings in the default audit output', async () => {
		const summary = await auditCrossContamination(REPO_ROOT, {
			runPair: () => ({ exitCode: 0, stdout: '', stderr: '' }),
		});

		expect(summary.exitCode).toBe(0);
		expect(summary.messages).toEqual([
			'No cross-contamination detected: all test pairs pass when co-run.',
		]);
		expect(summary.messages.join('\n')).not.toContain('Hook test file');
		expect(summary.messages.join('\n')).not.toContain('Mock module not');
	});
});
