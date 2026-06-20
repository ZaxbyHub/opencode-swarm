import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CI_YML_PATH = join(
	import.meta.dir,
	'../../../../.github/workflows/ci.yml',
);

function extractRunUnitTestsStep(yml: string): string {
	// Normalize CRLF to LF so regex anchors work consistently
	const normalized = yml.replace(/\r\n/g, '\n');
	// The "Run unit tests" step starts at 6-space indentation under the jobs.*.steps key.
	// Its content ends before the next step (also at 6-space indent) or section comment.
	const match = normalized.match(
		/- name: Run unit tests[\s\S]*?(?=\n {6}- name:|\n {6}# ---|Z)/m,
	);
	return match ? match[0] : '';
}

describe('ci.yml integration — Task 1.2 wrapper script structural validation', () => {
	const yml = readFileSync(CI_YML_PATH, 'utf8');
	const step = extractRunUnitTestsStep(yml);

	test('"Run unit tests" step calls the wrapper script', () => {
		expect(step).toContain('bun scripts/ci/run-test-with-timeout.ts');
	});

	test('"Run unit tests" step includes --kill-timeout 180', () => {
		expect(step).toContain('--kill-timeout 180');
	});

	test('"Run unit tests" step preserves error detection with grep -qE', () => {
		expect(step).toContain('grep -qE');
	});

	test('"Run unit tests" step preserves shard file list mechanism', () => {
		expect(step).toContain('shard-tests.txt');
	});

	test('"Run unit tests" step does NOT contain raw bun --smol test "$f" invocation', () => {
		// The old raw pattern was: bun --smol test "$f" --timeout 120000
		expect(step).not.toContain('bun --smol test "$f"');
	});
});
