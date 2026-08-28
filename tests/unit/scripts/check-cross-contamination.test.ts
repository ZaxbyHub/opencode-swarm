import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	auditCrossContamination,
	buildPairCommand,
	collectHookWarnings,
	evaluatePairResult,
	HOOK_ISOLATION_BASENAMES,
	lastLines,
	matchesHookStepGlob,
	PAIRS,
	readPassCount,
	toRepoRelativePath,
} from '../../../scripts/check-cross-contamination';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

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

	test('toRepoRelativePath normalizes separators to forward slashes', () => {
		const rel = toRepoRelativePath(
			'C:\\repo',
			'C:\\repo\\tests\\unit\\hooks\\x.test.ts',
		);
		expect(rel).toBe('tests/unit/hooks/x.test.ts');
	});
});

describe('check-cross-contamination — pair result classification', () => {
	const cleanPair = PAIRS[0];
	const knownPair = PAIRS[1];

	test('classifies an exit-0 co-run as clean', () => {
		const result = evaluatePairResult(cleanPair, {
			exitCode: 0,
			stdout: '57 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('clean');
		expect(result.messages).toEqual([]);
		expect(result.expectedPasses).toBe(57);
	});

	test('classifies a pre-existing shortfall as known_issue', () => {
		const result = evaluatePairResult(knownPair, {
			exitCode: 1,
			stdout: ' 71 pass\n',
			stderr: '',
		});
		expect(result.kind).toBe('known_issue');
		expect(result.actualPasses).toBe(71);
		expect(result.messages.join('\n')).toContain('known baseline: 71');
	});

	test('classifies a pass-count drop below the baseline as regression_pass_drop', () => {
		const result = evaluatePairResult(cleanPair, {
			exitCode: 1,
			stdout: '56 pass\nline 1\nline 2\n',
			stderr: '',
		});
		expect(result.kind).toBe('regression_pass_drop');
		expect(result.actualPasses).toBe(56);
		expect(result.messages.join('\n')).toContain(
			'Previously known baseline was 57',
		);
	});

	test('classifies a non-zero exit with enough passes as regression_unexpected_failure', () => {
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

describe('check-cross-contamination — hook audit warnings', () => {
	test('warns for recursive mock.module files outside the isolation list and notices uncovered top-level files', () => {
		const tmpDir = canonicalMkdtemp('cross-contamination-hooks-');
		const mockModuleToken = 'mock.' + 'module';
		try {
			const hooksRoot = path.join(tmpDir, 'tests', 'unit', 'hooks');
			fs.mkdirSync(path.join(hooksRoot, 'nested'), { recursive: true });

			fs.writeFileSync(
				path.join(hooksRoot, 'nested', 'leaky-new.test.ts'),
				`${mockModuleToken}('../../../src/x.js', () => ({}));\n`,
			);
			fs.writeFileSync(
				path.join(hooksRoot, 'new-uncovered.test.ts'),
				'test("placeholder", () => {});\n',
			);
			fs.writeFileSync(
				path.join(hooksRoot, HOOK_ISOLATION_BASENAMES[0]),
				`${mockModuleToken}('../../../src/y.js', () => ({}));\n`,
			);

			const warnings = collectHookWarnings(tmpDir);
			expect(warnings).toHaveLength(2);
			expect(warnings.join('\n')).toContain(
				`tests/unit/hooks/nested/leaky-new.test.ts uses ${mockModuleToken}() but is not in the CI isolation step file list`,
			);
			expect(warnings.join('\n')).toContain(
				'tests/unit/hooks/new-uncovered.test.ts is not covered by any named CI step glob or the isolation list',
			);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test('matches the checked-in hook step glob policy', () => {
		expect(
			matchesHookStepGlob('knowledge-reader-key-normalization.test.ts'),
		).toBe(true);
		expect(matchesHookStepGlob('totally-new-hook.test.ts')).toBe(false);
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
			collectWarnings: () => [],
		});

		expect(summary.exitCode).toBe(0);
		expect(seenRoots).toEqual([REPO_ROOT, REPO_ROOT]);
		expect(summary.repoRoot).toBe(REPO_ROOT);
		expect(summary.messages.at(-1)).toBe(
			'No cross-contamination detected: all test pairs pass when co-run.',
		);
	});

	test('keeps coverage warnings non-blocking when no regression is present', async () => {
		const summary = await auditCrossContamination(REPO_ROOT, {
			runPair: () => ({ exitCode: 0, stdout: '', stderr: '' }),
			collectWarnings: () => [
				'::notice title=Hook test file not in CI coverage::example',
			],
		});

		expect(summary.exitCode).toBe(0);
		expect(summary.coverageWarning).toBe(true);
		expect(summary.messages.join('\n')).toContain(
			'Audit checks completed with warnings (non-blocking).',
		);
	});
});
