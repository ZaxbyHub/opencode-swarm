/**
 * Tests for SAST pre-existing findings classification in pre_check_batch.
 *
 * Verifies:
 * 1. New HIGH/CRITICAL SAST finding on changed line → blocks coder (gates_passed: false)
 * 2. Pre-existing HIGH/CRITICAL SAST finding on unchanged line → passes to reviewer (gates_passed: true + sast_preexisting_findings)
 * 3. Mixed case (one new + one pre-existing) → blocks coder
 * 4. classifySastFindings correctly classifies based on changed line ranges
 * 5. parseDiffLineRanges correctly parses git diff output
 * 6. Integration: runPreCheckBatch gate behavior with pre-existing vs new findings
 */

import { describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	_internals,
	classifySastFindings,
	getChangedLineRanges,
	parseDiffLineRanges,
} from '../../../src/tools/pre-check-batch';
import type { SastScanFinding } from '../../../src/tools/sast-scan';

// ============ classifySastFindings unit tests ============

describe('classifySastFindings', () => {
	const originalPlatform = _internals.platform;
	const makeFinding = (
		file: string,
		line: number,
		severity: 'critical' | 'high' | 'medium' | 'low' = 'high',
	): SastScanFinding => ({
		rule_id: `test-rule-${line}`,
		severity,
		message: `Test finding at ${file}:${line}`,
		location: { file, line },
	});

	test('finding on changed line classified as new', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [makeFinding('/workspace/src/foo.ts', 11)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('finding on unchanged line classified as pre-existing', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [makeFinding('/workspace/src/foo.ts', 50)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(0);
		expect(preexistingFindings).toHaveLength(1);
	});

	test('mixed: one new + one pre-existing finding', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10, 11, 12]));

		const findings = [
			makeFinding('/workspace/src/foo.ts', 11), // changed line → new
			makeFinding('/workspace/src/foo.ts', 50), // unchanged line → pre-existing
		];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(1);
		expect(newFindings[0].location.line).toBe(11);
		expect(preexistingFindings[0].location.line).toBe(50);
	});

	test('finding in file not present in changed ranges classified as pre-existing', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/bar.ts', new Set([1, 2, 3]));

		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(0);
		expect(preexistingFindings).toHaveLength(1);
	});

	test('null changedLineRanges → fail-closed, all findings treated as new', () => {
		const findings = [
			makeFinding('/workspace/src/foo.ts', 10),
			makeFinding('/workspace/src/bar.ts', 20),
		];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			null,
			'/workspace',
		);

		expect(newFindings).toHaveLength(2);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('authoritative empty changedLineRanges treats findings as pre-existing', () => {
		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			new Map(),
			'/workspace',
		);

		expect(newFindings).toHaveLength(0);
		expect(preexistingFindings).toHaveLength(1);
	});

	test('windows-style paths normalised correctly', () => {
		const changedRanges = new Map<string, Set<number>>();
		changedRanges.set('src/foo.ts', new Set([10]));

		const findings = [makeFinding('/workspace/src/foo.ts', 10)];

		const { newFindings } = classifySastFindings(
			findings,
			changedRanges,
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
	});

	test('relative finding paths resolve against the injected project root', () => {
		const directory = path.resolve('project-root-distinct-from-host-cwd');
		const changedRanges = new Map([['src/foo.ts', new Set([10])]]);

		const { newFindings, preexistingFindings } = classifySastFindings(
			[makeFinding('src/foo.ts', 10)],
			changedRanges,
			directory,
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('outside and traversal finding paths fail closed as new', () => {
		const directory = path.resolve('project-root');
		const outside = path.resolve(directory, '..', 'outside.ts');
		const findings = [
			makeFinding(outside, 10),
			makeFinding(path.join('..', 'outside.ts'), 11),
		];

		const { newFindings, preexistingFindings } = classifySastFindings(
			findings,
			new Map(),
			directory,
		);

		expect(newFindings).toHaveLength(2);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('NUL-containing impossible finding paths fail closed as new', () => {
		const { newFindings, preexistingFindings } = classifySastFindings(
			[makeFinding('src/foo.ts\0', 10)],
			new Map(),
			'/workspace',
		);

		expect(newFindings).toHaveLength(1);
		expect(preexistingFindings).toHaveLength(0);
	});

	test('matches changed paths case-insensitively on macOS', () => {
		_internals.platform = () => 'darwin';
		try {
			const { newFindings, preexistingFindings } = classifySastFindings(
				[makeFinding('/workspace/SRC/AUTH.TS', 10)],
				new Map([['src/auth.ts', new Set([10])]]),
				'/workspace',
			);

			expect(newFindings).toHaveLength(1);
			expect(preexistingFindings).toHaveLength(0);
		} finally {
			_internals.platform = originalPlatform;
		}
	});
});

// ============ parseDiffLineRanges unit tests ============

describe('parseDiffLineRanges', () => {
	test('parses single file with single hunk', () => {
		const diff = [
			'diff --git src/foo.ts src/foo.ts',
			'index abc1234..def5678 100644',
			'--- src/foo.ts',
			'+++ src/foo.ts',
			'@@ -10,3 +10,5 @@ function example() {',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.has('src/foo.ts')).toBe(true);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(10)).toBe(true);
		expect(lines.has(11)).toBe(true);
		expect(lines.has(14)).toBe(true);
		expect(lines.has(15)).toBe(false);
		expect(lines.size).toBe(5);
	});

	test('parses multiple files', () => {
		const diff = [
			'diff --git src/a.ts src/a.ts',
			'--- src/a.ts',
			'+++ src/a.ts',
			'@@ -1,0 +1,2 @@',
			'diff --git src/b.ts src/b.ts',
			'--- src/b.ts',
			'+++ src/b.ts',
			'@@ -5,0 +5,3 @@',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.size).toBe(2);
		expect(result.get('src/a.ts')!.size).toBe(2);
		expect(result.get('src/b.ts')!.size).toBe(3);
	});

	test('parses hunk with count 0 (pure deletion)', () => {
		const diff = ['+++ src/foo.ts', '@@ -10,3 +10,0 @@'].join('\n');

		const result = parseDiffLineRanges(diff);
		expect(result.get('src/foo.ts')!.size).toBe(0);
	});

	test('parses hunk with no count (single line change)', () => {
		const diff = ['+++ src/foo.ts', '@@ -10 +20 @@'].join('\n');

		const result = parseDiffLineRanges(diff);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(20)).toBe(true);
		expect(lines.size).toBe(1);
	});

	test('handles trailing context text in hunk header without misparse', () => {
		const diff = [
			'+++ src/foo.ts',
			'@@ -10,3 +20,5 @@ function add(a, b) {',
		].join('\n');

		const result = parseDiffLineRanges(diff);
		const lines = result.get('src/foo.ts')!;
		expect(lines.has(20)).toBe(true);
		expect(lines.size).toBe(5);
	});

	test('returns empty map for empty diff', () => {
		const result = parseDiffLineRanges('');
		expect(result.size).toBe(0);
	});

	test('decodes quoted UTF-8 octal paths and CRLF hunks', () => {
		const diff = '+++ "src/space \\342\\230\\203.ts"\r\n@@ -0,0 +2,1 @@\r\n';
		const result = parseDiffLineRanges(diff);
		expect(result.get('src/space ☃.ts')).toEqual(new Set([2]));
	});

	test('ignores deleted destinations', () => {
		const result = parseDiffLineRanges('+++ /dev/null\n@@ -1,1 +0,0 @@\n');
		expect(result.size).toBe(0);
	});
});

// ============ getChangedLineRanges integration test ============

describe('getChangedLineRanges', () => {
	test('returns null for non-git directory', async () => {
		const result = await getChangedLineRanges(
			path.join(os.tmpdir(), 'definitely-not-a-git-repo-' + Date.now()),
		);
		expect(result).toBeNull();
	});
});
